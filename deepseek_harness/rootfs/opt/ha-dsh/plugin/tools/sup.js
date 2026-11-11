/**
 * Supervisor / system tools (`sup_*`).
 *
 * Reads wrap one documented Supervisor endpoint. Writes follow the capability
 * model: add-on lifecycle operations require the `allow_addon_management`
 * option AND a single-use confirmation token; uninstall/restore are destructive
 * and additionally require `confirm_slug` to equal the target slug.
 *
 * @module plugin/tools/sup
 */

import { sup, waitForJob } from '../../lib/supervisor.js'
import { canManageAddons, classify, consumeApproval, needsApproval } from '../../lib/safety.js'
import { fail, ok, redact, renderJson, toErrorResult, truncate, ToolError } from '../../lib/result.js'

/** Output schema shared by every tool (canonical envelope). */
const OBJECT_SCHEMA = { type: 'object', additionalProperties: true }

/**
 * Build one tool definition.
 * @param {string} name
 * @param {string} description
 * @param {object} parameters JSON Schema
 * @param {(args: Record<string, any>) => Promise<object>} execute
 * @returns {object}
 */
function defineTool(name, description, parameters, execute) {
  return {
    name,
    description,
    parameters,
    output: { schema: OBJECT_SCHEMA, render: renderJson },
    xClass: classify(name),
    execute,
  }
}

/** @param {unknown} value @returns {string|undefined} */
function asString(value) {
  return typeof value === 'string' && value !== '' ? value : undefined
}

/** @param {unknown} value @returns {string[]|undefined} */
function asArray(value) {
  if (value === undefined) return undefined
  if (Array.isArray(value)) return value.map((item) => String(item))
  if (typeof value === 'string' && value !== '') return [value]
  return undefined
}

/** @param {number} ms */
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/** Source label for the meta envelope. */
function source(method, path) {
  return `${method} ${path}`
}

/**
 * Call one Supervisor path and throw a mapped ToolError on a non-2xx answer.
 * @param {string} path
 * @param {'GET'|'POST'|'PUT'|'DELETE'} [method]
 * @param {unknown} [body]
 * @param {{ timeoutMs?: number }} [options]
 * @returns {Promise<any>}
 */
async function supJson(path, method = 'GET', body = undefined, options = {}) {
  const response = await sup(path, method, body, options)
  if (response.ok) return response.data
  const data = response.data
  const message =
    data !== null && typeof data === 'object' && typeof data.message === 'string'
      ? data.message
      : `Supervisor returned HTTP ${response.status} for ${path}`
  if (response.status === 404) throw new ToolError('NOT_FOUND', message)
  if (response.status === 401 || response.status === 403) {
    throw new ToolError('FORBIDDEN', message, {
      hint: 'The add-on needs hassio_api with the manager role for this endpoint.',
    })
  }
  if (response.status === 400 || response.status === 409) {
    throw new ToolError('INVALID_ARGUMENT', message)
  }
  throw new ToolError('UPSTREAM_ERROR', message, { retryable: response.status >= 500 })
}

/** Wrap a tool body so raw errors never escape. */
function guarded(body) {
  return async (args = {}) => {
    const sources = []
    try {
      return await body(args, sources)
    } catch (error) {
      return toErrorResult(/** @type {Error} */ (error), sources)
    }
  }
}

/** Get an add-on info record without failing the whole tool. */
async function addonInfoSafe(slug) {
  try {
    return await supJson(`/addons/${encodeURIComponent(slug)}/info`)
  } catch {
    return null
  }
}

/** Wait (bounded) for an add-on to reach one of the expected states. */
async function waitForAddonState(slug, expected, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs
  let info = await addonInfoSafe(slug)
  while (Date.now() < deadline) {
    if (info !== null && typeof info === 'object' && expected.includes(info.state)) return info
    await sleep(1_000)
    info = await addonInfoSafe(slug)
  }
  return info
}

/** Standard approval plan for an add-on lifecycle operation. */
function addonPlan(action, slug, info, details = {}) {
  return {
    action,
    target: slug,
    impact: details.impact ?? 'The app is stopped or restarted; its entities and UI are unavailable while it starts.',
    rollback: details.rollback ?? 'Start the app again with sup_addon_start; no data is removed.',
    backup:
      details.backup ?? { available: false, suggestion: 'Create a backup with sup_backup_create before risky changes.' },
    facts: {
      slug,
      state: info?.state ?? null,
      version: info?.version ?? null,
      version_latest: info?.version_latest ?? null,
      ...(details.facts ?? {}),
    },
  }
}

/** Capability gate for add-on management; returns a failed envelope or null. */
function addonManagementGate() {
  if (!canManageAddons()) {
    return fail('FORBIDDEN', 'Add-on management is disabled by the add-on options.', {
      hint: 'Enable the "allow_addon_management" option in the add-on configuration first.',
    })
  }
  return null
}

const tools = [
  defineTool(
    'sup_get_info',
    'Read system, Supervisor, Core, host, OS or network information from the Supervisor.',
    {
      type: 'object',
      properties: {
        sections: {
          type: 'array',
          items: { type: 'string', enum: ['system', 'supervisor', 'core', 'host', 'os', 'network'] },
          description: 'Which sections to fetch; defaults to system/supervisor/core/host.',
        },
      },
      additionalProperties: false,
    },
    guarded(async (args, sources) => {
      const wanted = asArray(args.sections) ?? ['system', 'supervisor', 'core', 'host']
      const endpoints = {
        system: '/info',
        supervisor: '/supervisor/info',
        core: '/core/info',
        host: '/host/info',
        os: '/os/info',
        network: '/network/info',
      }
      const warnings = []
      const data = {}
      for (const section of wanted) {
        const path = endpoints[section]
        if (path === undefined) {
          warnings.push({ code: 'UNKNOWN_SECTION', message: `Unknown section: ${section}` })
          continue
        }
        try {
          data[section] = await supJson(path)
          sources.push(source('GET', path))
        } catch (error) {
          // A missing/invalid token is fatal: never report a hollow success.
          if (error?.code === 'FORBIDDEN') throw error
          warnings.push({ code: 'PARTIAL', message: `${section}: ${error.message}` })
        }
      }
      const system = data.system ?? {}
      const host = data.host ?? {}
      const core = data.core ?? {}
      const supervisorInfo = data.supervisor ?? {}
      const summary = {
        versions: {
          core: core.version ?? null,
          supervisor: supervisorInfo.version ?? null,
          os: data.os?.version ?? null,
          machine: system.machine ?? null,
        },
        channel: supervisorInfo.channel ?? null,
        healthy: system.healthy ?? null,
        supported: system.supported ?? null,
        arch: system.arch ?? data.os?.board ?? null,
        time_zone: system.timezone ?? null,
        disk_free: host.disk_free ?? null,
        disk_total: host.disk_total ?? null,
        disk_used: host.disk_used ?? null,
      }
      return ok(`Supervisor ${summary.versions.supervisor ?? 'unknown'}, Core ${summary.versions.core ?? 'unknown'}`, {
        summary,
        ...data,
      }, { source: sources, warnings })
    }),
  ),

  defineTool(
    'sup_get_resolution',
    'Read Supervisor resolution issues, unsupported/unhealthy reasons and suggestions.',
    {
      type: 'object',
      properties: {
        include_checks: { type: 'boolean', description: 'Include the detailed check list (default false).' },
      },
      additionalProperties: false,
    },
    guarded(async (args, sources) => {
      const data = await supJson('/resolution/info')
      sources.push(source('GET', '/resolution/info'))
      const record = data !== null && typeof data === 'object' ? data : {}
      const output = {
        unsupported: record.unsupported ?? [],
        unhealthy: record.unhealthy ?? [],
        issues: record.issues ?? [],
        suggestions: record.suggestions ?? [],
      }
      if (args.include_checks === true) output.checks = record.checks ?? []
      const issueCount = Array.isArray(output.issues) ? output.issues.length : 0
      return ok(
        `${issueCount} resolution issue(s)${output.unhealthy.length ? ', system unhealthy' : ''}`,
        output,
        { source: sources },
      )
    }),
  ),

  defineTool(
    'sup_get_updates',
    'List available Core, Supervisor, OS and app updates.',
    { type: 'object', properties: {}, additionalProperties: false },
    guarded(async (_args, sources) => {
      const data = await supJson('/available_updates')
      sources.push(source('GET', '/available_updates'))
      const updates = Array.isArray(data?.available_updates)
        ? data.available_updates
        : Array.isArray(data)
          ? data
          : []
      return ok(`${updates.length} update(s) available`, { updates, count: updates.length }, { source: sources })
    }),
  ),

  defineTool(
    'sup_list_addons',
    'List installed apps (add-ons) with state, version and update flags.',
    {
      type: 'object',
      properties: {
        include_stats: { type: 'boolean', description: 'Include CPU/memory stats per app (slow; default false).' },
      },
      additionalProperties: false,
    },
    guarded(async (args, sources) => {
      const data = await supJson('/addons')
      sources.push(source('GET', '/addons'))
      const addons = Array.isArray(data?.addons) ? data.addons : Array.isArray(data) ? data : []
      const mapped = addons.map((addon) => ({
        slug: addon.slug,
        name: addon.name,
        version: addon.version ?? null,
        version_latest: addon.version_latest ?? null,
        update_available: addon.update_available ?? false,
        state: addon.state ?? null,
        repository: addon.repository ?? null,
        boot: addon.boot ?? null,
        watchdog: addon.watchdog ?? null,
      }))
      if (args.include_stats === true) {
        for (const addon of mapped.slice(0, 30)) {
          try {
            addon.stats = await supJson(`/addons/${encodeURIComponent(addon.slug)}/stats`)
            sources.push(source('GET', `/addons/${addon.slug}/stats`))
          } catch {
            addon.stats = null
          }
        }
      }
      return ok(`${mapped.length} installed apps`, {
        addons: mapped,
        count: mapped.length,
        update_count: mapped.filter((addon) => addon.update_available).length,
      }, { source: sources })
    }),
  ),

  defineTool(
    'sup_get_addon',
    'Read one app (add-on) info record, with secret-looking option values redacted.',
    {
      type: 'object',
      properties: {
        slug: { type: 'string', description: 'App slug, e.g. core_mosquitto or local_my_app.' },
        include_options: {
          type: 'boolean',
          description: 'Include option values (password-like values stay redacted).',
        },
      },
      required: ['slug'],
      additionalProperties: false,
    },
    guarded(async (args, sources) => {
      const slug = asString(args.slug)
      if (slug === undefined) return fail('INVALID_ARGUMENT', 'slug is required.')
      const data = await supJson(`/addons/${encodeURIComponent(slug)}/info`)
      sources.push(source('GET', `/addons/${slug}/info`))
      const record = data !== null && typeof data === 'object' ? { ...data } : {}
      const options = record.options !== null && typeof record.options === 'object' ? record.options : {}
      record.option_keys = Object.keys(options).sort()
      if (args.include_options !== true) delete record.options
      const redactedRecord = redact(record)
      return ok(`${record.name ?? slug} ${record.version ?? ''}`.trim(), redactedRecord, {
        source: sources,
        redacted: record.options !== undefined,
      })
    }),
  ),

  defineTool(
    'sup_addon_logs',
    'Read the log tail of one app (add-on).',
    {
      type: 'object',
      properties: {
        slug: { type: 'string', description: 'App slug.' },
        lines: { type: 'number', description: 'Number of lines (default 100).' },
        verbose: { type: 'boolean', description: 'Verbose Supervisor log output (default false).' },
        previous_boot: { type: 'boolean', description: 'Read the previous boot log (default false).' },
      },
      required: ['slug'],
      additionalProperties: false,
    },
    guarded(async (args, sources) => {
      const slug = asString(args.slug)
      if (slug === undefined) return fail('INVALID_ARGUMENT', 'slug is required.')
      const lines = Math.min(2000, Math.max(1, Number(args.lines ?? 100)))
      const params = new URLSearchParams({ lines: String(lines) })
      if (args.verbose === true) params.set('verbose', 'true')
      const path =
        args.previous_boot === true
          ? `/addons/${encodeURIComponent(slug)}/logs/boots/-1`
          : `/addons/${encodeURIComponent(slug)}/logs`
      const data = await supJson(`${path}?${params.toString()}`)
      sources.push(source('GET', path))
      const text = typeof data === 'string' ? data : JSON.stringify(data)
      const clean = text.replace(/\u001b\[[0-9;]*m/g, '')
      const clipped = truncate(clean, 65_536)
      return ok(`${slug} log (${lines} lines)`, {
        slug,
        log: clipped.text,
        requested_lines: lines,
        previous_boot: args.previous_boot === true,
      }, { source: sources, truncated: clipped.truncated })
    }),
  ),

  defineTool(
    'sup_get_store',
    'Read the app store catalogue, optionally filtered by a query.',
    {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Case-insensitive substring match on slug/name/description.' },
        installed: { type: 'boolean', description: 'Filter by installed state when set.' },
        available_only: { type: 'boolean', description: 'Only show apps available on this system (default true).' },
        slug: { type: 'string', description: 'Read one store app instead of the whole catalogue.' },
        limit: { type: 'number', description: 'Max entries (default 100).' },
      },
      additionalProperties: false,
    },
    guarded(async (args, sources) => {
      const slug = asString(args.slug)
      if (slug !== undefined) {
        const data = await supJson(`/store/addons/${encodeURIComponent(slug)}`)
        sources.push(source('GET', `/store/addons/${slug}`))
        return ok(`Store app ${slug}`, redact(data ?? {}), { source: sources, redacted: true })
      }
      const data = await supJson('/store')
      sources.push(source('GET', '/store'))
      const all = Array.isArray(data?.addons) ? data.addons : Array.isArray(data) ? data : []
      const query = asString(args.query)?.toLowerCase()
      const limit = Math.min(1000, Math.max(1, Number(args.limit ?? 100)))
      const availableOnly = args.available_only !== false
      const mapped = all
        .filter((addon) => addon !== null && typeof addon === 'object')
        .filter((addon) => (args.installed === undefined ? true : Boolean(addon.installed) === args.installed))
        .filter((addon) => (availableOnly ? addon.available !== false : true))
        .filter((addon) => {
          if (query === undefined) return true
          return `${addon.slug ?? ''} ${addon.name ?? ''} ${addon.description ?? ''}`.toLowerCase().includes(query)
        })
        .map((addon) => ({
          slug: addon.slug,
          name: addon.name,
          version: addon.version ?? null,
          description: typeof addon.description === 'string' ? addon.description.slice(0, 200) : null,
          installed: addon.installed ?? false,
          available: addon.available ?? null,
          repository: addon.repository ?? null,
          url: addon.url ?? null,
        }))
      const page = mapped.slice(0, limit)
      return ok(`${mapped.length} store apps`, {
        addons: page,
        repositories: Array.isArray(data?.repositories) ? data.repositories : [],
        count: mapped.length,
      }, { source: sources, truncated: mapped.length > page.length })
    }),
  ),

  defineTool(
    'sup_get_logs',
    'Read Supervisor, Core or host logs (plain text tail).',
    {
      type: 'object',
      properties: {
        target: { type: 'string', enum: ['supervisor', 'core', 'host'], description: 'Which log to read.' },
        identifiers: { type: 'array', items: { type: 'string' }, description: 'Filter by log identifiers.' },
        boot: { type: 'number', description: 'Read a specific boot id (default latest).' },
        lines: { type: 'number', description: 'Number of lines (default 200).' },
        verbose: { type: 'boolean', description: 'Verbose output (default false).' },
      },
      additionalProperties: false,
    },
    guarded(async (args, sources) => {
      const target = ['supervisor', 'core', 'host'].includes(args.target) ? args.target : 'supervisor'
      const lines = Math.min(5000, Math.max(1, Number(args.lines ?? 200)))
      const params = new URLSearchParams({ lines: String(lines) })
      if (args.verbose === true) params.set('verbose', 'true')
      for (const identifier of asArray(args.identifiers) ?? []) params.append('identifier', identifier)
      const boot = Number(args.boot)
      const base = `/${target}/logs`
      const path = Number.isFinite(boot) && boot > 0 ? `${base}/boots/${boot}` : base
      const data = await supJson(`${path}?${params.toString()}`)
      sources.push(source('GET', path))
      const text = typeof data === 'string' ? data : JSON.stringify(data)
      const clipped = truncate(text.replace(/\u001b\[[0-9;]*m/g, ''), 65_536)
      return ok(`${target} logs (${lines} lines)`, {
        target,
        log: clipped.text,
        identifiers: asArray(args.identifiers) ?? [],
        boot: Number.isFinite(boot) && boot > 0 ? boot : null,
      }, { source: sources, truncated: clipped.truncated })
    }),
  ),

  defineTool(
    'sup_backup_list',
    'List backups with date/type/size and staleness information.',
    {
      type: 'object',
      properties: {
        include_settings: { type: 'boolean', description: 'Include backup settings (default true).' },
      },
      additionalProperties: false,
    },
    guarded(async (args, sources) => {
      const data = await supJson('/backups/info')
      sources.push(source('GET', '/backups/info'))
      const record = data !== null && typeof data === 'object' ? data : {}
      const backups = Array.isArray(record.backups) ? record.backups : Array.isArray(data) ? data : []
      const output = {
        backups: backups.map((backup) => ({
          slug: backup.slug,
          name: backup.name,
          date: backup.date ?? null,
          type: backup.type ?? null,
          size: backup.size ?? null,
          protected: backup.protected ?? false,
          locations: backup.locations ?? null,
        })),
        count: backups.length,
        days_until_stale: record.days_until_stale ?? null,
        last_attempt: record.last_attempt ?? null,
      }
      if (args.include_settings !== false) output.settings = record.settings ?? null
      return ok(`${backups.length} backups`, output, { source: sources })
    }),
  ),

  defineTool(
    'sup_backup_info',
    'Read one backup, including the versions and contents it holds.',
    {
      type: 'object',
      properties: {
        slug: { type: 'string', description: 'Backup slug.' },
      },
      required: ['slug'],
      additionalProperties: false,
    },
    guarded(async (args, sources) => {
      const slug = asString(args.slug)
      if (slug === undefined) return fail('INVALID_ARGUMENT', 'slug is required.')
      const data = await supJson(`/backups/${encodeURIComponent(slug)}/info`)
      sources.push(source('GET', `/backups/${slug}/info`))
      return ok(`Backup ${slug}`, data ?? {}, { source: sources })
    }),
  ),

  defineTool(
    'sup_job_status',
    'Read a Supervisor job, optionally waiting for it to finish.',
    {
      type: 'object',
      properties: {
        job_id: { type: 'string', description: 'Supervisor job id.' },
        wait: { type: 'boolean', description: 'Poll until the job finishes (default false).' },
        timeout_s: { type: 'number', description: 'Wait timeout in seconds (default 120).' },
      },
      required: ['job_id'],
      additionalProperties: false,
    },
    guarded(async (args, sources) => {
      const jobId = asString(args.job_id)
      if (jobId === undefined) return fail('INVALID_ARGUMENT', 'job_id is required.')
      if (args.wait === true) {
        const timeoutMs = Math.min(900, Math.max(5, Number(args.timeout_s ?? 120))) * 1000
        const job = await waitForJob(jobId, { timeoutMs })
        sources.push(source('GET', `/jobs/${jobId}`))
        return ok(`Job ${jobId}: done (${job.progress}%)`, job, { source: sources })
      }
      const job = await supJson(`/jobs/${encodeURIComponent(jobId)}`)
      sources.push(source('GET', `/jobs/${jobId}`))
      const record = job !== null && typeof job === 'object' ? job : {}
      return ok(`Job ${jobId}: ${record.done === true ? 'done' : 'running'} (${record.progress ?? 0}%)`, record, {
        source: sources,
      })
    }),
  ),

  defineTool(
    'sup_store_reload',
    'Re-read the app repositories and the local apps folder (picks up new local apps).',
    { type: 'object', properties: {}, additionalProperties: false },
    guarded(async (_args, sources) => {
      const gate = addonManagementGate()
      if (gate !== null) return gate
      await supJson('/store/reload', 'POST', {})
      sources.push(source('POST', '/store/reload'))
      return ok('App store reloaded', { reloaded: true }, { source: sources })
    }),
  ),

  defineTool(
    'sup_set_addon_options',
    'Validate and update app (add-on) options; changes apply at the next start.',
    {
      type: 'object',
      properties: {
        slug: { type: 'string', description: 'App slug, or "self".' },
        options: { type: 'object', additionalProperties: true, description: 'Option values to set.' },
        boot: { type: 'string', enum: ['auto', 'manual', 'manual_only'], description: 'Boot behaviour.' },
        watchdog: { type: 'boolean', description: 'Watchdog enabled.' },
        network: { type: 'object', additionalProperties: true, description: 'Network settings patch.' },
        validate: { type: 'boolean', description: 'Validate options with the Supervisor first (default true).' },
        confirmation_token: { type: 'string', description: 'Token from a previous NEEDS_APPROVAL result.' },
      },
      required: ['slug', 'options'],
      additionalProperties: false,
    },
    guarded(async (args, sources) => {
      const gate = addonManagementGate()
      if (gate !== null) return gate
      const slug = asString(args.slug)
      if (slug === undefined) return fail('INVALID_ARGUMENT', 'slug is required.')
      const body = { options: args.options ?? {} }
      if (typeof args.boot === 'string') body.boot = args.boot
      if (typeof args.watchdog === 'boolean') body.watchdog = args.watchdog
      if (args.network !== null && typeof args.network === 'object') body.network = args.network
      if (args.validate !== false) {
        const validation = await supJson(`/addons/${encodeURIComponent(slug)}/options/validate`, 'POST', body)
        sources.push(source('POST', `/addons/${slug}/options/validate`))
        const record = validation !== null && typeof validation === 'object' ? validation : {}
        if (record.valid === false || (Array.isArray(record.errors) && record.errors.length > 0)) {
          return fail('INVALID_ARGUMENT', `The Supervisor rejected the options for ${slug}.`, {
            hint: 'Fix the values against the app option schema and retry.',
            data: { validation: redact(record) },
            source: sources,
          })
        }
      }
      const tokenRequired = slug !== 'self'
      if (tokenRequired && args.confirmation_token === undefined) {
        return needsApproval('sup_set_addon_options', args, {
          action: `Change options of ${slug}`,
          target: slug,
          impact: 'Option changes take effect the next time the app starts; some apps need a restart.',
          rollback: 'Restore the previous option values and restart the app.',
          backup: { available: true, suggestion: 'Consider sup_backup_create (partial, addons=[slug]) first.' },
          facts: { slug, option_keys: Object.keys(args.options ?? {}).sort() },
        })
      }
      if (tokenRequired) consumeApproval('sup_set_addon_options', args)
      const applied = await supJson(`/addons/${encodeURIComponent(slug)}/options`, 'POST', body)
      sources.push(source('POST', `/addons/${slug}/options`))
      return ok(`Options updated for ${slug} (applies on next start)`, {
        slug,
        applied: redact(applied ?? {}),
        applies_on: 'next start',
      }, { source: sources, redacted: true })
    }),
  ),

  defineTool(
    'sup_addon_start',
    'Start an app (add-on); requires allow_addon_management and a confirmation token.',
    {
      type: 'object',
      properties: {
        slug: { type: 'string', description: 'App slug.' },
        wait: { type: 'boolean', description: 'Wait until it reports started (default true).' },
        confirmation_token: { type: 'string', description: 'Token from a previous NEEDS_APPROVAL result.' },
      },
      required: ['slug'],
      additionalProperties: false,
    },
    guarded(async (args, sources) => {
      const slug = asString(args.slug)
      if (slug === undefined) return fail('INVALID_ARGUMENT', 'slug is required.')
      const gate = addonManagementGate()
      if (gate !== null) return gate
      const info = await addonInfoSafe(slug)
      if (info !== null) sources.push(source('GET', `/addons/${slug}/info`))
      if (args.confirmation_token === undefined) {
        return needsApproval('sup_addon_start', args, addonPlan(`Start ${slug}`, slug, info, {
          impact: 'The app starts and its entities become available; resource usage increases.',
          rollback: 'Stop it again with sup_addon_stop.',
        }))
      }
      consumeApproval('sup_addon_start', args)
      await supJson(`/addons/${encodeURIComponent(slug)}/start`, 'POST', {})
      sources.push(source('POST', `/addons/${slug}/start`))
      const final = args.wait === false ? null : await waitForAddonState(slug, ['started', 'running', 'error'])
      if (final !== null) sources.push(source('GET', `/addons/${slug}/info`))
      return ok(`Start requested for ${slug}${final?.state ? ` (${final.state})` : ''}`, {
        slug,
        requested: 'start',
        state: final?.state ?? 'starting',
      }, { source: sources })
    }),
  ),

  defineTool(
    'sup_addon_stop',
    'Stop an app (add-on); requires allow_addon_management and a confirmation token.',
    {
      type: 'object',
      properties: {
        slug: { type: 'string', description: 'App slug.' },
        wait: { type: 'boolean', description: 'Wait until it reports stopped (default true).' },
        confirmation_token: { type: 'string', description: 'Token from a previous NEEDS_APPROVAL result.' },
      },
      required: ['slug'],
      additionalProperties: false,
    },
    guarded(async (args, sources) => {
      const slug = asString(args.slug)
      if (slug === undefined) return fail('INVALID_ARGUMENT', 'slug is required.')
      const gate = addonManagementGate()
      if (gate !== null) return gate
      const info = await addonInfoSafe(slug)
      if (info !== null) sources.push(source('GET', `/addons/${slug}/info`))
      if (args.confirmation_token === undefined) {
        return needsApproval('sup_addon_stop', args, addonPlan(`Stop ${slug}`, slug, info, {
          impact: 'The app and everything it provides become unavailable until it is started again.',
          rollback: 'Start it again with sup_addon_start.',
        }))
      }
      consumeApproval('sup_addon_stop', args)
      await supJson(`/addons/${encodeURIComponent(slug)}/stop`, 'POST', {})
      sources.push(source('POST', `/addons/${slug}/stop`))
      const final = args.wait === false ? null : await waitForAddonState(slug, ['stopped', 'error'])
      if (final !== null) sources.push(source('GET', `/addons/${slug}/info`))
      return ok(`Stop requested for ${slug}${final?.state ? ` (${final.state})` : ''}`, {
        slug,
        requested: 'stop',
        state: final?.state ?? 'stopping',
      }, { source: sources })
    }),
  ),

  defineTool(
    'sup_addon_restart',
    'Restart an app (add-on); requires allow_addon_management and a confirmation token.',
    {
      type: 'object',
      properties: {
        slug: { type: 'string', description: 'App slug.' },
        wait: { type: 'boolean', description: 'Wait until it reports started (default true).' },
        confirmation_token: { type: 'string', description: 'Token from a previous NEEDS_APPROVAL result.' },
      },
      required: ['slug'],
      additionalProperties: false,
    },
    guarded(async (args, sources) => {
      const slug = asString(args.slug)
      if (slug === undefined) return fail('INVALID_ARGUMENT', 'slug is required.')
      const gate = addonManagementGate()
      if (gate !== null) return gate
      const info = await addonInfoSafe(slug)
      if (info !== null) sources.push(source('GET', `/addons/${slug}/info`))
      if (args.confirmation_token === undefined) {
        return needsApproval('sup_addon_restart', args, addonPlan(`Restart ${slug}`, slug, info, {
          impact: 'The app is briefly unavailable while it restarts; in-flight work is interrupted.',
          rollback: 'Start it again with sup_addon_start if it does not come back.',
        }))
      }
      consumeApproval('sup_addon_restart', args)
      await supJson(`/addons/${encodeURIComponent(slug)}/restart`, 'POST', {})
      sources.push(source('POST', `/addons/${slug}/restart`))
      const final = args.wait === false ? null : await waitForAddonState(slug, ['started', 'running', 'error'])
      if (final !== null) sources.push(source('GET', `/addons/${slug}/info`))
      return ok(`Restart requested for ${slug}${final?.state ? ` (${final.state})` : ''}`, {
        slug,
        requested: 'restart',
        state: final?.state ?? 'starting',
      }, { source: sources })
    }),
  ),

  defineTool(
    'sup_addon_install',
    'Install an app from the store; requires allow_addon_management and a confirmation token.',
    {
      type: 'object',
      properties: {
        store_slug: { type: 'string', description: 'Store app slug, e.g. local_my_app or core_mosquitto.' },
        background: { type: 'boolean', description: 'Return a job id instead of blocking (default true).' },
        confirmation_token: { type: 'string', description: 'Token from a previous NEEDS_APPROVAL result.' },
      },
      required: ['store_slug'],
      additionalProperties: false,
    },
    guarded(async (args, sources) => {
      const slug = asString(args.store_slug)
      if (slug === undefined) return fail('INVALID_ARGUMENT', 'store_slug is required.')
      const gate = addonManagementGate()
      if (gate !== null) return gate
      let availability = null
      try {
        availability = await supJson(`/store/addons/${encodeURIComponent(slug)}/availability`)
        sources.push(source('GET', `/store/addons/${slug}/availability`))
      } catch (error) {
        if (error?.code === 'NOT_FOUND') {
          return fail('NOT_FOUND', `Store app ${slug} was not found.`, {
            hint: 'Run sup_store_reload after writing a local app, then sup_get_store to find the exact slug.',
            source: sources,
          })
        }
      }
      if (availability !== null && typeof availability === 'object' && availability.available === false) {
        return fail('UNSUPPORTED', `Store app ${slug} is not available on this system.`, {
          hint: 'Check the architecture/machine requirements in sup_get_info and the app availability reasons.',
          data: { reasons: availability.reasons ?? null },
          source: sources,
        })
      }
      if (args.confirmation_token === undefined) {
        return needsApproval('sup_addon_install', args, {
          action: `Install app ${slug}`,
          target: slug,
          impact: 'The Supervisor builds or pulls the image; the app may start automatically depending on its boot setting.',
          rollback: 'Uninstall it with sup_addon_uninstall if it is not wanted.',
          backup: { available: true, suggestion: 'Consider sup_backup_create before installing something stateful.' },
          facts: { store_slug: slug, available: availability?.available ?? null },
        })
      }
      consumeApproval('sup_addon_install', args)
      const background = args.background !== false
      const job = await supJson(`/store/addons/${encodeURIComponent(slug)}/install`, 'POST', { background })
      sources.push(source('POST', `/store/addons/${slug}/install`))
      return ok(`Install started for ${slug}`, {
        store_slug: slug,
        background,
        job_id: job?.job_id ?? null,
        response: redact(job ?? {}),
        next: job?.job_id ? `sup_job_status job_id=${job.job_id} wait=true` : 'sup_job_status / sup_addon_logs',
      }, { source: sources, redacted: true })
    }),
  ),

  defineTool(
    'sup_addon_update',
    'Update an app (optionally with a pre-update backup); requires allow_addon_management and a token.',
    {
      type: 'object',
      properties: {
        slug: { type: 'string', description: 'App slug.' },
        backup: { type: 'boolean', description: 'Create a partial backup before updating (default true).' },
        background: { type: 'boolean', description: 'Return a job id instead of blocking (default true).' },
        confirmation_token: { type: 'string', description: 'Token from a previous NEEDS_APPROVAL result.' },
      },
      required: ['slug'],
      additionalProperties: false,
    },
    guarded(async (args, sources) => {
      const slug = asString(args.slug)
      if (slug === undefined) return fail('INVALID_ARGUMENT', 'slug is required.')
      const gate = addonManagementGate()
      if (gate !== null) return gate
      const info = await addonInfoSafe(slug)
      if (info !== null) sources.push(source('GET', `/addons/${slug}/info`))
      if (info !== null && info.update_available === false) {
        return fail('CONFLICT', `${slug} has no update available.`, {
          hint: 'Run sup_get_updates or sup_store_reload if you expected one (local apps need a raised version).',
        })
      }
      if (args.confirmation_token === undefined) {
        return needsApproval('sup_addon_update', args, addonPlan(`Update ${slug}`, slug, info, {
          impact: `The app is rebuilt or re-pulled from ${info?.version ?? 'the current version'} to ${
            info?.version_latest ?? 'the latest version'
          }; data migrations may run.`,
          rollback: 'Restore the pre-update backup if the new version misbehaves.',
          backup: {
            available: true,
            suggestion: 'sup_addon_update keeps backup=true (a partial backup runs first).',
          },
          facts: {
            from_version: info?.version ?? null,
            to_version: info?.version_latest ?? null,
            backup: args.backup !== false,
          },
        }))
      }
      consumeApproval('sup_addon_update', args)
      const body = { background: args.background !== false, backup: args.backup !== false }
      const job = await supJson(`/store/addons/${encodeURIComponent(slug)}/update`, 'POST', body)
      sources.push(source('POST', `/store/addons/${slug}/update`))
      return ok(`Update started for ${slug}`, {
        slug,
        ...body,
        job_id: job?.job_id ?? null,
        response: redact(job ?? {}),
        next: job?.job_id ? `sup_job_status job_id=${job.job_id} wait=true` : 'sup_job_status / sup_addon_logs',
      }, { source: sources, redacted: true })
    }),
  ),

  defineTool(
    'sup_addon_uninstall',
    'Uninstall an app (destructive); requires allow_addon_management, a token and confirm_slug.',
    {
      type: 'object',
      properties: {
        slug: { type: 'string', description: 'App slug.' },
        remove_config: { type: 'boolean', description: 'Also delete the app config folder (default false).' },
        confirm_slug: { type: 'string', description: 'Must exactly repeat slug to confirm the destructive action.' },
        confirmation_token: { type: 'string', description: 'Token from a previous NEEDS_APPROVAL result.' },
      },
      required: ['slug', 'confirm_slug'],
      additionalProperties: false,
    },
    guarded(async (args, sources) => {
      const slug = asString(args.slug)
      if (slug === undefined) return fail('INVALID_ARGUMENT', 'slug is required.')
      if (args.confirm_slug !== slug) {
        return fail('CONFLICT', 'confirm_slug must exactly match slug for an uninstall.', {
          hint: 'Repeat the call with confirm_slug set to the same app slug after the user confirms.',
        })
      }
      const gate = addonManagementGate()
      if (gate !== null) return gate
      const info = await addonInfoSafe(slug)
      if (info !== null) sources.push(source('GET', `/addons/${slug}/info`))
      const removeConfig = args.remove_config === true
      if (args.confirmation_token === undefined) {
        return needsApproval('sup_addon_uninstall', args, addonPlan(`Uninstall ${slug}`, slug, info, {
          impact: removeConfig
            ? 'The app is removed AND its configuration/data folder is deleted. This cannot be undone.'
            : 'The app is removed; its configuration/data folder is kept so a reinstall can reuse it.',
          rollback:
            'Reinstall the app; if remove_config=true, restore the pre-uninstall backup instead (data is gone otherwise).',
          backup: {
            available: false,
            suggestion: 'Run sup_backup_create (partial, addons=[slug]) before uninstalling with data removal.',
          },
          facts: { slug, remove_config: removeConfig, state: info?.state ?? null },
        }))
      }
      consumeApproval('sup_addon_uninstall', args)
      const job = await supJson(`/addons/${encodeURIComponent(slug)}/uninstall`, 'POST', {
        remove_config: removeConfig,
      })
      sources.push(source('POST', `/addons/${slug}/uninstall`))
      return ok(`Uninstall requested for ${slug}`, {
        slug,
        remove_config: removeConfig,
        job_id: job?.job_id ?? null,
        data_removed: removeConfig,
      }, { source: sources })
    }),
  ),

  defineTool(
    'sup_addon_rebuild',
    'Rebuild a local app image; requires allow_addon_management and a confirmation token.',
    {
      type: 'object',
      properties: {
        slug: { type: 'string', description: 'App slug (local apps usually start with local_).' },
        force: { type: 'boolean', description: 'Force a rebuild even for image-based apps (default true).' },
        confirmation_token: { type: 'string', description: 'Token from a previous NEEDS_APPROVAL result.' },
      },
      required: ['slug'],
      additionalProperties: false,
    },
    guarded(async (args, sources) => {
      const slug = asString(args.slug)
      if (slug === undefined) return fail('INVALID_ARGUMENT', 'slug is required.')
      const gate = addonManagementGate()
      if (gate !== null) return gate
      const info = await addonInfoSafe(slug)
      if (info !== null) sources.push(source('GET', `/addons/${slug}/info`))
      if (args.confirmation_token === undefined) {
        return needsApproval('sup_addon_rebuild', args, addonPlan(`Rebuild ${slug}`, slug, info, {
          impact: 'The Supervisor rebuilds the local app image and restarts it; the app is briefly unavailable.',
          rollback: 'Fix the files and rebuild again; the previous image may be cached until pruned.',
          backup: { available: true, suggestion: 'Consider a partial backup before a version change.' },
          facts: { slug, force: args.force !== false, version: info?.version ?? null },
        }))
      }
      consumeApproval('sup_addon_rebuild', args)
      const body = { force: args.force !== false }
      const job = await supJson(`/addons/${encodeURIComponent(slug)}/rebuild`, 'POST', body)
      sources.push(source('POST', `/addons/${slug}/rebuild`))
      return ok(`Rebuild requested for ${slug}`, {
        slug,
        ...body,
        job_id: job?.job_id ?? null,
        response: redact(job ?? {}),
        next: 'sup_job_status / sup_addon_logs; on failure read sup_get_logs target=supervisor',
      }, { source: sources, redacted: true })
    }),
  ),

  defineTool(
    'sup_backup_create',
    'Create a full or partial backup (background job by default).',
    {
      type: 'object',
      properties: {
        mode: { type: 'string', enum: ['full', 'partial'], description: 'Backup scope (default partial).' },
        name: { type: 'string', description: 'Backup name, e.g. dsh-pre-core-20261111-1000.' },
        homeassistant: {
          type: 'boolean',
          description: 'Include Home Assistant config (partial only, default true).',
        },
        folders: { type: 'array', items: { type: 'string' }, description: 'Extra folders to include.' },
        addons: { type: 'array', items: { type: 'string' }, description: 'App slugs to include.' },
        background: { type: 'boolean', description: 'Return a job id instead of blocking (default true).' },
        password: { type: 'string', description: 'Optional encryption password (never stored or echoed).' },
      },
      additionalProperties: false,
    },
    guarded(async (args, sources) => {
      const mode = args.mode === 'full' ? 'full' : 'partial'
      const background = args.background !== false
      const body = { background }
      if (typeof args.name === 'string' && args.name !== '') body.name = args.name
      if (mode === 'partial') {
        body.homeassistant = args.homeassistant !== false
        const folders = asArray(args.folders)
        const addons = asArray(args.addons)
        if (folders !== undefined) body.folders = folders
        if (addons !== undefined) body.addons = addons
      }
      if (typeof args.password === 'string' && args.password !== '') {
        body.password = args.password
      }
      const job = await supJson(mode === 'full' ? '/backups/new/full' : '/backups/new/partial', 'POST', body)
      sources.push(source('POST', mode === 'full' ? '/backups/new/full' : '/backups/new/partial'))
      const warnings = []
      if (typeof args.password === 'string' && args.password !== '') {
        warnings.push({
          code: 'ENCRYPTED_BACKUP',
          message:
            'The backup is encrypted; the password is not stored by this add-on. Keep it safe or you cannot restore.',
        })
      }
      const visible = { ...job }
      delete visible.password
      return ok(`Backup started (${mode})`, {
        mode,
        name: body.name ?? null,
        background,
        job_id: visible?.job_id ?? null,
        slug: visible?.slug ?? null,
        response: redact(visible ?? {}),
        next: visible?.job_id ? `sup_job_status job_id=${visible.job_id} wait=true` : 'sup_backup_list',
      }, { source: sources, redacted: true, warnings })
    }),
  ),

  defineTool(
    'sup_backup_restore',
    'Restore a backup (destructive); requires a confirmation token and confirm_slug.',
    {
      type: 'object',
      properties: {
        slug: { type: 'string', description: 'Backup slug.' },
        mode: { type: 'string', enum: ['full', 'partial'], description: 'Restore scope (default full).' },
        homeassistant: { type: 'boolean', description: 'Restore HA config (partial only, default true).' },
        addons: { type: 'array', items: { type: 'string' }, description: 'App slugs to restore.' },
        folders: { type: 'array', items: { type: 'string' }, description: 'Folders to restore.' },
        background: { type: 'boolean', description: 'Return a job id instead of blocking (default true).' },
        confirm_slug: { type: 'string', description: 'Must exactly repeat slug to confirm the destructive restore.' },
        confirmation_token: { type: 'string', description: 'Token from a previous NEEDS_APPROVAL result.' },
      },
      required: ['slug', 'confirm_slug'],
      additionalProperties: false,
    },
    guarded(async (args, sources) => {
      const slug = asString(args.slug)
      if (slug === undefined) return fail('INVALID_ARGUMENT', 'slug is required.')
      if (args.confirm_slug !== slug) {
        return fail('CONFLICT', 'confirm_slug must exactly match slug for a restore.', {
          hint: 'State clearly what will be overwritten, then repeat the call with confirm_slug equal to the backup slug.',
        })
      }
      if (args.confirmation_token === undefined) {
        return needsApproval('sup_backup_restore', args, {
          action: `Restore backup ${slug}`,
          target: slug,
          impact:
            'The current configuration/apps are overwritten by the backup contents. Home Assistant Core and the affected apps restart during the restore.',
          rollback:
            'Create and verify a fresh backup BEFORE restoring: the pre-restore state is otherwise lost. Use config_restore for single files instead.',
          backup: {
            available: true,
            suggestion: 'sup_backup_create partial homeassistant=true name=dsh-pre-restore-<ts> and verify it first.',
          },
          facts: {
            slug,
            mode: args.mode === 'full' ? 'full' : 'partial',
            homeassistant: args.homeassistant !== false,
            addons: asArray(args.addons) ?? [],
            folders: asArray(args.folders) ?? [],
          },
        })
      }
      consumeApproval('sup_backup_restore', args)
      const mode = args.mode === 'full' ? 'full' : 'partial'
      const body = { background: args.background !== false }
      if (mode === 'partial') {
        body.homeassistant = args.homeassistant !== false
        const folders = asArray(args.folders)
        const addons = asArray(args.addons)
        if (folders !== undefined) body.folders = folders
        if (addons !== undefined) body.addons = addons
      }
      const job = await supJson(`/backups/${encodeURIComponent(slug)}/restore/${mode}`, 'POST', body)
      sources.push(source('POST', `/backups/${slug}/restore/${mode}`))
      return ok(`Restore started from ${slug} (${mode})`, {
        slug,
        mode,
        ...body,
        job_id: job?.job_id ?? null,
        response: redact(job ?? {}),
        next: 'sup_job_status wait=true, then ha_get_config_check and memory_refresh after the restore',
      }, { source: sources, redacted: true })
    }),
  ),

  defineTool(
    'sup_core_update',
    'Update Home Assistant Core; requires a confirmation token and a backup by default.',
    {
      type: 'object',
      properties: {
        version: { type: 'string', description: 'Target version; defaults to the latest available.' },
        backup: { type: 'boolean', description: 'Ask the Supervisor for a partial backup first (default true).' },
        background: { type: 'boolean', description: 'Return a job id instead of blocking (default true).' },
        confirmation_token: { type: 'string', description: 'Token from a previous NEEDS_APPROVAL result.' },
      },
      additionalProperties: false,
    },
    guarded(async (args, sources) => {
      let coreInfo = null
      try {
        coreInfo = await supJson('/core/info')
        sources.push(source('GET', '/core/info'))
      } catch {
        coreInfo = null
      }
      if (args.confirmation_token === undefined) {
        return needsApproval('sup_core_update', args, {
          action: 'Update Home Assistant Core',
          target: args.version !== undefined ? `Core ${args.version}` : 'Home Assistant Core (latest)',
          impact:
            'Home Assistant restarts into the new version (unavailable ~1-3 minutes); database migrations may run and cannot be reversed. A downgrade is not supported.',
          rollback:
            'Only restoring a pre-update backup returns to the old version. Verify that backup exists and appears in sup_backup_list before updating.',
          backup: {
            available: args.backup !== false,
            suggestion:
              'sup_backup_create partial homeassistant=true name=dsh-pre-core-<ts>, then verify it in sup_backup_list.',
          },
          facts: {
            current_version: coreInfo?.version ?? null,
            target_version: args.version ?? null,
            backup: args.backup !== false,
          },
        })
      }
      consumeApproval('sup_core_update', args)
      const body = { backup: args.backup !== false, background: args.background !== false }
      if (typeof args.version === 'string' && args.version !== '') body.version = args.version
      const job = await supJson('/core/update', 'POST', body)
      sources.push(source('POST', '/core/update'))
      return ok('Home Assistant Core update started', {
        ...body,
        current_version: coreInfo?.version ?? null,
        job_id: job?.job_id ?? null,
        response: redact(job ?? {}),
        next: 'sup_job_status wait=true, then ha_get_config to confirm the new version',
      }, { source: sources, redacted: true })
    }),
  ),
]

export { tools }
export default tools
