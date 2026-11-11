/**
 * Home Assistant Core tools (`ha_*`).
 *
 * Read tools wrap one documented REST endpoint (or one small fixed sequence)
 * through the Supervisor proxy. Action tools follow the safety model in
 * `lib/safety.js`: denied service domains are refused, safety domains ask for a
 * single-use confirmation token first, and `ha_restart` additionally requires
 * the `allow_restarts` add-on option.
 *
 * @module plugin/tools/ha
 */

import {
  callService,
  checkConfig,
  ha,
  renderTemplate,
} from '../../lib/ha-core.js'
import { sup } from '../../lib/supervisor.js'
import { haWs } from '../../lib/ha-ws.js'
import {
  canRestart,
  checkService,
  classify,
  consumeApproval,
  needsApproval,
} from '../../lib/safety.js'
import { fail, ok, redact, renderJson, toErrorResult, ToolError } from '../../lib/result.js'

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

/**
 * Call one HA Core REST path and throw a mapped ToolError on a non-2xx answer.
 * @param {string} path
 * @param {'GET'|'POST'} [method]
 * @param {unknown} [body]
 * @returns {Promise<any>}
 */
async function coreRequest(path, method = 'GET', body = undefined) {
  const response = await ha(path, method, body)
  if (response.ok) return response.data
  throw httpError(response, path)
}

/**
 * Map an HA Core HTTP error to the tool taxonomy.
 * @param {{ ok: boolean, status: number, data: unknown }} response
 * @param {string} path
 * @returns {Error}
 */
function httpError(response, path) {
  const data = response.data
  const message =
    data !== null && typeof data === 'object' && typeof data.message === 'string'
      ? data.message
      : `Home Assistant returned HTTP ${response.status} for ${path}`
  if (response.status === 404) {
    return new ToolError('NOT_FOUND', message)
  }
  if (response.status === 401 || response.status === 403) {
    return new ToolError('FORBIDDEN', message)
  }
  if (response.status === 400 || response.status === 422) {
    return new ToolError('INVALID_ARGUMENT', message)
  }
  return new ToolError('UPSTREAM_ERROR', message, { retryable: response.status >= 500 })
}

/** Source label for the meta envelope. */
function source(method, path) {
  return `${method} /api${path}`
}

/** Read state objects and index them by entity id. */
async function readStates() {
  const states = await coreRequest('/states')
  return Array.isArray(states) ? states : []
}

/**
 * Resolve entity ids that belong to an area (directly or via their device).
 * @param {string} areaId
 * @returns {Promise<Set<string>>}
 */
async function areaEntityIds(areaId) {
  const entities = await haWs('config/entity_registry/list')
  const devices = await haWs('config/device_registry/list')
  const deviceArea = new Map()
  if (Array.isArray(devices)) {
    for (const device of devices) {
      if (device !== null && typeof device === 'object') deviceArea.set(device.id, device.area_id)
    }
  }
  const ids = new Set()
  if (Array.isArray(entities)) {
    for (const entity of entities) {
      if (entity === null || typeof entity !== 'object') continue
      const area = entity.area_id ?? deviceArea.get(entity.device_id)
      if (area === areaId) ids.add(entity.entity_id)
    }
  }
  return ids
}

/**
 * Look up registry facts for one entity id (best effort; never fatal).
 * @param {string} entityId
 * @returns {Promise<Record<string, unknown>|null>}
 */
async function entityRegistryFacts(entityId) {
  try {
    const entities = await haWs('config/entity_registry/list')
    if (!Array.isArray(entities)) return null
    const entity = entities.find((item) => item !== null && typeof item === 'object' && item.entity_id === entityId)
    if (entity === undefined) return null
    let areaId = entity.area_id ?? null
    let areaName = null
    if (entity.device_id !== undefined && entity.device_id !== null) {
      try {
        const devices = await haWs('config/device_registry/list')
        if (Array.isArray(devices)) {
          const device = devices.find((item) => item !== null && typeof item === 'object' && item.id === entity.device_id)
          if (device !== undefined) areaId = areaId ?? device.area_id ?? null
        }
      } catch {
        /* registry diagnostics are best-effort */
      }
    }
    if (areaId !== null) {
      try {
        const areas = await haWs('config/area_registry/list')
        if (Array.isArray(areas)) {
          const area = areas.find((item) => item !== null && typeof item === 'object' && item.area_id === areaId)
          if (area !== undefined) areaName = area.name ?? null
        }
      } catch {
        /* best effort */
      }
    }
    return {
      entity_id: entity.entity_id,
      name: entity.name ?? null,
      platform: entity.platform ?? null,
      device_id: entity.device_id ?? null,
      area_id: areaId,
      area_name: areaName,
      disabled_by: entity.disabled_by ?? null,
      hidden_by: entity.hidden_by ?? null,
      category: entity.category ?? null,
    }
  } catch {
    return null
  }
}

/**
 * Wrap a tool body so raw errors never escape.
 * @param {(args: Record<string, any>, sources: string[]) => Promise<object>} body
 */
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

/** Read a template render response that HA may return as text or JSON. */
function normaliseRendered(data) {
  if (typeof data === 'string') return { rendered: data, error: null }
  if (data !== null && typeof data === 'object') {
    return {
      rendered: typeof data.rendered === 'string' ? data.rendered : JSON.stringify(data.rendered ?? data),
      error: typeof data.error === 'string' ? data.error : null,
      is_static: typeof data.is_static === 'boolean' ? data.is_static : undefined,
    }
  }
  return { rendered: String(data ?? ''), error: null }
}

/** Level ordering for `system_log` filtering. */
const LOG_LEVELS = ['debug', 'info', 'warning', 'error', 'critical']

/** @param {object} tool */
const tools = [
  defineTool(
    'ha_get_config',
    'Read Home Assistant version/location/timezone plus core state and component count.',
    {
      type: 'object',
      properties: {
        sections: {
          type: 'array',
          items: { type: 'string', enum: ['core', 'state', 'components'] },
          description: 'Which sections to fetch; defaults to all of them.',
        },
      },
      additionalProperties: false,
    },
    guarded(async (args, sources) => {
      const wanted = new Set(asArray(args.sections) ?? ['core', 'state', 'components'])
      const warnings = []
      const data = {}
      if (wanted.has('core')) {
        const config = await coreRequest('/config')
        sources.push(source('GET', '/config'))
        const record = config !== null && typeof config === 'object' ? config : {}
        data.version = record.version ?? null
        data.location_name = record.location_name ?? null
        data.time_zone = record.time_zone ?? null
        data.unit_system = record.unit_system ?? null
        data.config_dir = record.config_dir ?? null
        data.components_count = Array.isArray(record.components) ? record.components.length : null
      }
      if (wanted.has('state')) {
        try {
          data.core_state = await coreRequest('/core/state')
          sources.push(source('GET', '/core/state'))
        } catch (error) {
          warnings.push({ code: 'PARTIAL', message: `Core state unavailable: ${error.message}` })
        }
      }
      if (wanted.has('components')) {
        try {
          const components = await coreRequest('/components')
          sources.push(source('GET', '/components'))
          data.components_count = Array.isArray(components) ? components.length : data.components_count ?? null
        } catch (error) {
          warnings.push({ code: 'PARTIAL', message: `Component list unavailable: ${error.message}` })
        }
      }
      return ok(`Home Assistant ${data.version ?? 'unknown version'}`, data, { source: sources, warnings })
    }),
  ),

  defineTool(
    'ha_get_states',
    'List entity states, filtered by domain, entity id or area, with optional attributes.',
    {
      type: 'object',
      properties: {
        domain: {
          type: 'array',
          items: { type: 'string' },
          description: 'Only these domains, e.g. ["light","sensor"].',
        },
        entity_ids: { type: 'array', items: { type: 'string' }, description: 'Only these entity ids.' },
        area_id: { type: 'string', description: 'Only entities in this area (resolved via the registries).' },
        include_attributes: { type: 'boolean', description: 'Include the full attributes object (default false).' },
        limit: { type: 'number', description: 'Maximum entities returned (default 200, max 1000).' },
      },
      additionalProperties: false,
    },
    guarded(async (args, sources) => {
      const all = await readStates()
      sources.push(source('GET', '/states'))
      const domains = asArray(args.domain)
      const entityIds = asArray(args.entity_ids)
      const warnings = []
      let areaIds = null
      if (asString(args.area_id) !== undefined) {
        try {
          areaIds = await areaEntityIds(args.area_id)
        } catch (error) {
          return fail('UNSUPPORTED', `Cannot resolve area ${args.area_id}: ${error.message}`, {
            hint: 'Pass explicit entity_ids instead; the registry WebSocket commands are not available on this Home Assistant version.',
            source: sources,
          })
        }
      }
      let filtered = all.filter((state) => state !== null && typeof state === 'object' && typeof state.entity_id === 'string')
      if (domains !== undefined && domains.length > 0) {
        const wanted = new Set(domains)
        filtered = filtered.filter((state) => {
          const domain = state.entity_id.split('.')[0]
          return wanted.has(domain) || wanted.has(state.entity_id)
        })
      }
      if (entityIds !== undefined && entityIds.length > 0) {
        const wanted = new Set(entityIds)
        filtered = filtered.filter((state) => wanted.has(state.entity_id))
      }
      if (areaIds !== null) filtered = filtered.filter((state) => areaIds.has(state.entity_id))
      const byDomain = {}
      for (const state of filtered) {
        const domain = state.entity_id.split('.')[0]
        byDomain[domain] = (byDomain[domain] ?? 0) + 1
      }
      const limit = Math.min(1000, Math.max(1, Number(args.limit ?? 200)))
      const page = filtered.slice(0, limit).map((state) => {
        const item = {
          entity_id: state.entity_id,
          state: state.state,
          last_changed: state.last_changed,
          last_updated: state.last_updated,
        }
        if (args.include_attributes === true) item.attributes = state.attributes ?? {}
        else if (state.attributes !== null && typeof state.attributes === 'object' && state.attributes.friendly_name !== undefined) {
          item.friendly_name = state.attributes.friendly_name
        }
        return item
      })
      return ok(`${filtered.length} entities (${page.length} returned)`, {
        count: filtered.length,
        returned: page.length,
        by_domain: byDomain,
        states: page,
      }, { source: sources, truncated: filtered.length > page.length, warnings })
    }),
  ),

  defineTool(
    'ha_get_state',
    'Read one entity state with friendly name and registry area/device facts.',
    {
      type: 'object',
      properties: {
        entity_id: { type: 'string', description: 'Entity id, e.g. light.kitchen' },
      },
      required: ['entity_id'],
      additionalProperties: false,
    },
    guarded(async (args, sources) => {
      const entityId = asString(args.entity_id)
      if (entityId === undefined) return fail('INVALID_ARGUMENT', 'entity_id is required.')
      const state = await coreRequest(`/states/${encodeURIComponent(entityId)}`)
      sources.push(source('GET', `/states/${entityId}`))
      const record = state !== null && typeof state === 'object' ? state : {}
      const attributes = record.attributes !== null && typeof record.attributes === 'object' ? record.attributes : {}
      const registry = await entityRegistryFacts(entityId)
      const data = {
        entity_id: record.entity_id ?? entityId,
        state: record.state ?? null,
        attributes,
        friendly_name: attributes.friendly_name ?? null,
        last_changed: record.last_changed ?? null,
        last_updated: record.last_updated ?? null,
        registry,
      }
      return ok(`${entityId} is ${data.state}`, data, { source: sources })
    }),
  ),

  defineTool(
    'ha_get_services',
    'List the canonical action (service) catalogue, optionally filtered.',
    {
      type: 'object',
      properties: {
        domain: { type: 'array', items: { type: 'string' }, description: 'Only these service domains.' },
        query: { type: 'string', description: 'Case-insensitive substring match on service name/description.' },
        include_fields: { type: 'boolean', description: 'Include the service field names (default false).' },
      },
      additionalProperties: false,
    },
    guarded(async (args, sources) => {
      const data = await coreRequest('/services')
      sources.push(source('GET', '/services'))
      const domains = asArray(args.domain)
      const wanted = domains === undefined ? null : new Set(domains)
      const query = asString(args.query)?.toLowerCase()
      const includeFields = args.include_fields === true
      const result = []
      for (const entry of Array.isArray(data) ? data : []) {
        if (entry === null || typeof entry !== 'object' || typeof entry.domain !== 'string') continue
        if (wanted !== null && !wanted.has(entry.domain)) continue
        const services = []
        for (const [name, definition] of Object.entries(entry.services ?? {})) {
          const record = definition !== null && typeof definition === 'object' ? definition : {}
          const serviceName = String(record.name ?? name)
          const description = typeof record.description === 'string' ? record.description : ''
          if (query !== undefined && !`${name} ${serviceName} ${description}`.toLowerCase().includes(query)) continue
          const item = { service: name, name: serviceName, description }
          if (includeFields) item.field_names = Object.keys(record.fields ?? {})
          services.push(item)
        }
        if (services.length > 0) result.push({ domain: entry.domain, services })
      }
      const serviceCount = result.reduce((total, entry) => total + entry.services.length, 0)
      return ok(`${result.length} domains, ${serviceCount} services`, {
        domains: result,
        domain_count: result.length,
        service_count: serviceCount,
      }, { source: sources })
    }),
  ),

  defineTool(
    'ha_get_history',
    'Read entity state history for a time window.',
    {
      type: 'object',
      properties: {
        entity_ids: { type: 'array', items: { type: 'string' }, description: 'Entities to read (required).' },
        start: { type: 'string', description: 'ISO timestamp; defaults to 24 hours ago.' },
        end: { type: 'string', description: 'ISO timestamp; defaults to now.' },
        minimal: { type: 'boolean', description: 'Return only state changes without attributes (default true).' },
        limit: { type: 'number', description: 'Max change entries overall (default 500).' },
      },
      required: ['entity_ids'],
      additionalProperties: false,
    },
    guarded(async (args, sources) => {
      const entityIds = asArray(args.entity_ids) ?? []
      if (entityIds.length === 0) return fail('INVALID_ARGUMENT', 'entity_ids must contain at least one entity id.')
      const start = asString(args.start) ?? new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString()
      const params = new URLSearchParams()
      const end = asString(args.end)
      if (end !== undefined) params.set('end_time', end)
      params.set('filter_entity_id', entityIds.join(','))
      if (args.minimal !== false) params.append('minimal_response', '')
      const query = params.toString()
      const data = await coreRequest(`/history/period/${encodeURIComponent(start)}?${query}`)
      sources.push(source('GET', `/history/period/${start}`))
      const limit = Math.min(5000, Math.max(1, Number(args.limit ?? 500)))
      const entities = []
      let total = 0
      for (const series of Array.isArray(data) ? data : []) {
        if (!Array.isArray(series) || series.length === 0) continue
        const entityId = typeof series[0].entity_id === 'string' ? series[0].entity_id : null
        const changes = series.slice(0, limit).map((entry) => ({
          state: entry.state ?? null,
          last_changed: entry.last_changed ?? null,
        }))
        total += series.length
        entities.push({ entity_id: entityId, change_count: series.length, changes })
      }
      return ok(`${entities.length} entities, ${total} changes`, {
        entities,
        total_changes: total,
        window: { start, end: end ?? null },
      }, { source: sources, truncated: total > limit })
    }),
  ),

  defineTool(
    'ha_get_logbook',
    'Read the Activity (logbook) feed for entities around an incident.',
    {
      type: 'object',
      properties: {
        entity_ids: { type: 'array', items: { type: 'string' }, description: 'Entities to include.' },
        start: { type: 'string', description: 'ISO timestamp; defaults to 24 hours ago.' },
        end: { type: 'string', description: 'ISO timestamp; defaults to now.' },
        limit: { type: 'number', description: 'Max entries (default 100).' },
      },
      additionalProperties: false,
    },
    guarded(async (args, sources) => {
      const start = asString(args.start) ?? new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString()
      const entityIds = asArray(args.entity_ids) ?? []
      const params = new URLSearchParams()
      for (const entityId of entityIds) params.append('entity', entityId)
      const end = asString(args.end)
      if (end !== undefined) params.set('end_time', end)
      const query = params.toString()
      const path = `/logbook/${encodeURIComponent(start)}${query === '' ? '' : `?${query}`}`
      const data = await coreRequest(path)
      sources.push(source('GET', `/logbook/${start}`))
      const limit = Math.min(1000, Math.max(1, Number(args.limit ?? 100)))
      const entries = Array.isArray(data) ? data.slice(0, limit) : []
      return ok(`${entries.length} logbook entries`, {
        entries,
        count: Array.isArray(data) ? data.length : 0,
        window: { start, end: end ?? null },
      }, { source: sources, truncated: Array.isArray(data) && data.length > entries.length })
    }),
  ),

  defineTool(
    'ha_get_error_log',
    'Read the tail of the Home Assistant error log, optionally filtered by regex.',
    {
      type: 'object',
      properties: {
        lines: { type: 'number', description: 'How many trailing lines to return (default 100).' },
        grep: { type: 'string', description: 'Case-insensitive regular expression to filter lines.' },
      },
      additionalProperties: false,
    },
    guarded(async (args, sources) => {
      const data = await coreRequest('/error_log')
      sources.push(source('GET', '/error_log'))
      const raw = typeof data === 'string' ? data : JSON.stringify(data)
      const allLines = raw.split('\n')
      let pattern = null
      const grep = asString(args.grep)
      if (grep !== undefined) {
        try {
          pattern = new RegExp(grep, 'i')
        } catch (error) {
          return fail('INVALID_ARGUMENT', `grep is not a valid regular expression: ${error.message}`)
        }
      }
      const matches = pattern === null ? allLines : allLines.filter((line) => pattern.test(line))
      const lines = Math.min(2000, Math.max(1, Number(args.lines ?? 100)))
      const tail = matches.slice(-lines)
      const entryPattern =
        /^(?<timestamp>\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.\d+)\s+(?<level>DEBUG|INFO|WARNING|ERROR|CRITICAL)\s+\((?<thread>[^)]*)\)\s+\[(?<logger>[^\]]+)\]\s*(?<message>.*)$/
      const entries = []
      for (const line of tail) {
        const match = entryPattern.exec(line)
        if (match === null) continue
        entries.push({
          timestamp: match.groups.timestamp,
          level: match.groups.level,
          thread: match.groups.thread,
          logger: match.groups.logger,
          message: match.groups.message,
        })
      }
      return ok(`${tail.length} log lines`, {
        lines: tail,
        entries,
        total_lines: allLines.length,
        matched_lines: matches.length,
        grep: grep ?? null,
      }, { source: sources, truncated: matches.length > tail.length })
    }),
  ),

  defineTool(
    'ha_get_config_check',
    'Validate the Home Assistant configuration (authoritative config check).',
    { type: 'object', properties: {}, additionalProperties: false },
    guarded(async (_args, sources) => {
      const data = await checkConfig()
      sources.push(source('POST', '/config/core/check_config'))
      const record = data !== null && typeof data === 'object' ? data : { result: String(data) }
      const result = String(record.result ?? '').toLowerCase()
      return ok(`Config check: ${result || 'unknown'}`, {
        result,
        errors: record.errors ?? null,
        warnings: record.warnings ?? null,
      }, { source: sources })
    }),
  ),

  defineTool(
    'ha_render_template',
    'Render a Jinja template server-side against real states (read-only).',
    {
      type: 'object',
      properties: {
        template: { type: 'string', description: 'Jinja2 template text.' },
        variables: { type: 'object', additionalProperties: true, description: 'Optional template variables.' },
      },
      required: ['template'],
      additionalProperties: false,
    },
    guarded(async (args, sources) => {
      const template = asString(args.template)
      if (template === undefined) return fail('INVALID_ARGUMENT', 'template is required.')
      const raw = await renderTemplate(template, args.variables)
      sources.push(source('POST', '/template'))
      return ok('Template rendered', normaliseRendered(raw), { source: sources })
    }),
  ),

  defineTool(
    'ha_list_automations',
    'List automations (and optionally scripts/scenes) with alias, state and last_triggered.',
    {
      type: 'object',
      properties: {
        include_scripts: { type: 'boolean', description: 'Include script.* entities (default false).' },
        include_scenes: { type: 'boolean', description: 'Include scene.* entities (default false).' },
        limit: { type: 'number', description: 'Max entries (default 200).' },
      },
      additionalProperties: false,
    },
    guarded(async (args, sources) => {
      const states = await readStates()
      sources.push(source('GET', '/states'))
      const wantedDomains = new Set(['automation'])
      if (args.include_scripts === true) wantedDomains.add('script')
      if (args.include_scenes === true) wantedDomains.add('scene')
      const items = []
      for (const state of states) {
        if (state === null || typeof state !== 'object' || typeof state.entity_id !== 'string') continue
        const domain = state.entity_id.split('.')[0]
        if (!wantedDomains.has(domain)) continue
        const attributes = state.attributes !== null && typeof state.attributes === 'object' ? state.attributes : {}
        items.push({
          entity_id: state.entity_id,
          domain,
          alias: attributes.friendly_name ?? null,
          state: state.state,
          last_triggered: attributes.last_triggered ?? null,
          id: attributes.id ?? null,
          mode: attributes.mode ?? null,
          current: attributes.current ?? null,
        })
      }
      items.sort((left, right) => String(left.alias ?? left.entity_id).localeCompare(String(right.alias ?? right.entity_id)))
      const limit = Math.min(2000, Math.max(1, Number(args.limit ?? 200)))
      const page = items.slice(0, limit)
      return ok(`${items.length} automations${wantedDomains.size > 1 ? ' (with scripts/scenes)' : ''}`, {
        automations: page,
        count: items.length,
        unmapped_yaml: [],
      }, {
        source: sources,
        truncated: items.length > page.length,
        warnings:
          items.length > 0
            ? []
            : [{ code: 'NO_ITEMS', message: 'No automations found in the state machine; check the entity registry if this is unexpected.' }],
      })
    }),
  ),

  defineTool(
    'ha_call_service',
    'Call a Home Assistant action (service). Denied domains are refused; safety domains need confirmation.',
    {
      type: 'object',
      properties: {
        domain: { type: 'string', description: 'Service domain, e.g. light' },
        service: { type: 'string', description: 'Service name, e.g. turn_on' },
        data: { type: 'object', additionalProperties: true, description: 'Service data object.' },
        target: {
          type: 'object',
          properties: {
            entity_id: { type: 'string' },
            device_id: { type: 'string' },
            area_id: { type: 'string' },
            floor_id: { type: 'string' },
            label_id: { type: 'string' },
          },
          additionalProperties: false,
          description: 'Optional target selector.',
        },
        return_response: { type: 'boolean', description: 'Ask Home Assistant for the service response (default false).' },
        confirmation_token: {
          type: 'string',
          description: 'Only for safety domains: the token from a previous NEEDS_APPROVAL result.',
        },
      },
      required: ['domain', 'service'],
      additionalProperties: false,
    },
    guarded(async (args, sources) => {
      const domain = asString(args.domain)
      const service = asString(args.service)
      if (domain === undefined || service === undefined) {
        return fail('INVALID_ARGUMENT', 'domain and service are required.')
      }
      const check = checkService(domain, service)
      if (!check.allowed) {
        return fail('FORBIDDEN', check.reason ?? `Calling ${domain}.${service} is not allowed.`, {
          hint: 'This domain can execute arbitrary code or bypass the Supervisor; use the dedicated tools instead.',
        })
      }
      if (domain === 'homeassistant' && (service === 'restart' || service === 'stop')) {
        return fail('FORBIDDEN', `homeassistant.${service} must not be called through ha_call_service.`, {
          hint: 'Use ha_restart, which checks the allow_restarts option and asks for confirmation.',
        })
      }
      const body = { ...(args.data !== null && typeof args.data === 'object' ? args.data : {}) }
      const targetKeys = ['entity_id', 'device_id', 'area_id', 'floor_id', 'label_id']
      const target = {}
      for (const key of targetKeys) {
        const value = args.target?.[key] ?? args[key]
        if (typeof value === 'string' || Array.isArray(value)) {
          target[key] = value
          body[key] = value
        }
      }
      const needsToken = check.safetyDomain === true || domain === 'homeassistant'
      if (needsToken && args.confirmation_token === undefined) {
        return needsApproval('ha_call_service', args, {
          action: `Call ${domain}.${service}`,
          target: Object.keys(target).length > 0 ? JSON.stringify(target) : domain,
          impact:
            'This acts on a safety-relevant device (lock, alarm, cover/valve, siren or camera) or on Home Assistant itself.',
          rollback: 'Physical effects may not be reversible; call the opposite action if the device supports it.',
          backup: { available: false, suggestion: 'No snapshot applies to service calls.' },
          facts: { domain, service, data_keys: Object.keys(body).sort() },
        })
      }
      if (needsToken) consumeApproval('ha_call_service', args)
      const response = await callService(domain, service, body, { returnResponse: args.return_response === true })
      sources.push(source('POST', `/services/${domain}/${service}`))
      return ok(`Called ${domain}.${service}`, {
        domain,
        service,
        target,
        response: redact(response),
      }, { source: sources, redacted: true })
    }),
  ),

  defineTool(
    'ha_reload',
    'Reload Home Assistant configuration (preferred over a restart).',
    {
      type: 'object',
      properties: {
        targets: {
          type: 'array',
          items: {
            type: 'string',
            enum: [
              'all',
              'core_config',
              'automations',
              'scripts',
              'scenes',
              'templates',
              'themes',
              'input_helpers',
              'frontend',
            ],
          },
          description: 'What to reload; defaults to ["all"].',
        },
      },
      additionalProperties: false,
    },
    guarded(async (args, sources) => {
      const requested = asArray(args.targets) ?? ['all']
      /** @type {[string,string][]} */
      const calls = []
      for (const target of requested) {
        switch (target) {
          case 'all':
            calls.push(['homeassistant', 'reload_all'])
            break
          case 'core_config':
            calls.push(['homeassistant', 'reload_core_config'])
            break
          case 'automations':
            calls.push(['automation', 'reload'])
            break
          case 'scripts':
            calls.push(['script', 'reload'])
            break
          case 'scenes':
            calls.push(['scene', 'reload'])
            break
          case 'templates':
            calls.push(['template', 'reload'])
            break
          case 'themes':
            calls.push(['frontend', 'reload_themes'])
            break
          case 'input_helpers':
            calls.push(['input_boolean', 'reload'])
            calls.push(['input_number', 'reload'])
            calls.push(['input_text', 'reload'])
            calls.push(['input_select', 'reload'])
            calls.push(['input_datetime', 'reload'])
            break
          case 'frontend':
            calls.push(['frontend', 'reload_themes'])
            break
          default:
            return fail('INVALID_ARGUMENT', `Unknown reload target: ${target}`)
        }
      }
      const results = []
      const warnings = []
      for (const [domain, service] of calls) {
        try {
          const response = await callService(domain, service)
          void response
          results.push({ target: `${domain}.${service}`, ok: true })
          sources.push(source('POST', `/services/${domain}/${service}`))
        } catch (error) {
          results.push({ target: `${domain}.${service}`, ok: false, error: error.message })
          warnings.push({ code: 'RELOAD_FAILED', message: `${domain}.${service}: ${error.message}` })
        }
      }
      const succeeded = results.filter((item) => item.ok).length
      if (succeeded === 0) {
        return fail('UPSTREAM_ERROR', 'No reload action succeeded.', {
          hint: 'Check ha_get_services for the reload actions this Home Assistant version supports.',
          data: { results },
          source: sources,
        })
      }
      return ok(`Reloaded ${succeeded}/${results.length} targets`, {
        requested,
        results,
        core_restart_needed_for_new_integrations: true,
      }, { source: sources, warnings })
    }),
  ),

  defineTool(
    'ha_restart',
    'Restart Home Assistant Core (disruptive; requires allow_restarts and a confirmation token).',
    {
      type: 'object',
      properties: {
        mode: { type: 'string', enum: ['restart', 'safe_mode'], description: 'safe_mode skips custom integrations.' },
        force: { type: 'boolean', description: 'Force the restart even if checks fail (default false).' },
        reason: { type: 'string', description: 'Why the restart is needed (shown in the approval plan).' },
        confirmation_token: { type: 'string', description: 'Token from a previous NEEDS_APPROVAL result.' },
      },
      required: ['reason'],
      additionalProperties: false,
    },
    guarded(async (args, sources) => {
      if (!canRestart()) {
        return fail('FORBIDDEN', 'Restarting Home Assistant is disabled by the add-on options.', {
          hint: 'Enable the "allow_restarts" option in the add-on configuration, or restart from Settings → System.',
        })
      }
      const mode = args.mode === 'safe_mode' ? 'safe_mode' : 'restart'
      const reason = asString(args.reason)
      if (reason === undefined) return fail('INVALID_ARGUMENT', 'reason is required for a restart.')
      if (args.confirmation_token === undefined) {
        return needsApproval('ha_restart', args, {
          action: mode === 'safe_mode' ? 'Restart Home Assistant Core in safe mode' : 'Restart Home Assistant Core',
          target: 'Home Assistant Core',
          impact:
            'Home Assistant is unavailable for roughly 30–120 seconds; running automations are interrupted; apps keep running.',
          rollback:
            'The service comes back on its own. If it does not start, use safe mode or restore a recent backup.',
          backup: {
            available: false,
            suggestion: 'Run sup_backup_create (partial, homeassistant=true) first if the config changed.',
            age_hours: null,
          },
          facts: { mode, force: args.force === true, reason },
        })
      }
      consumeApproval('ha_restart', args)
      // Supervisor-native endpoint (hassio_api + manager role), not the HA REST proxy.
      const response = await sup('/core/restart', 'POST', {
        safe_mode: mode === 'safe_mode',
        force: args.force === true,
      })
      sources.push('POST /core/restart')
      if (!response.ok) throw httpError(response, '/core/restart')
      return ok(`Home Assistant restart accepted (${mode})`, {
        mode,
        force: args.force === true,
        reason,
        accepted: true,
        response: redact(response.data),
      }, { source: sources, redacted: true })
    }),
  ),

  defineTool(
    'ha_list_registry',
    'List the entity, device or area registry via the Home Assistant WebSocket API.',
    {
      type: 'object',
      properties: {
        kind: { type: 'string', enum: ['entities', 'devices', 'areas'], description: 'Registry to list.' },
        domain: { type: 'string', description: 'Only entities in this domain.' },
        platform: { type: 'string', description: 'Only entries from this integration/platform.' },
        area_id: { type: 'string', description: 'Only entries assigned to this area.' },
        disabled: { type: 'boolean', description: 'Only disabled (true) or enabled (false) entries.' },
        hidden: { type: 'boolean', description: 'Only hidden (true) or visible (false) entries.' },
        limit: { type: 'number', description: 'Max entries (default 200).' },
      },
      additionalProperties: false,
    },
    guarded(async (args, sources) => {
      const kind = asString(args.kind) ?? 'entities'
      const command =
        kind === 'devices'
          ? 'config/device_registry/list'
          : kind === 'areas'
            ? 'config/area_registry/list'
            : 'config/entity_registry/list'
      const raw = await haWs(command)
      sources.push(`WS ${command}`)
      let items = Array.isArray(raw) ? raw : []
      const domain = asString(args.domain)
      if (domain !== undefined && kind === 'entities') {
        items = items.filter((item) => typeof item?.entity_id === 'string' && item.entity_id.startsWith(`${domain}.`))
      }
      const platform = asString(args.platform)
      if (platform !== undefined) items = items.filter((item) => item?.platform === platform)
      const areaId = asString(args.area_id)
      if (areaId !== undefined) items = items.filter((item) => item?.area_id === areaId)
      if (typeof args.disabled === 'boolean') {
        items = items.filter((item) => Boolean(item?.disabled_by) === args.disabled)
      }
      if (typeof args.hidden === 'boolean') {
        items = items.filter((item) => Boolean(item?.hidden_by) === args.hidden)
      }
      const limit = Math.min(5000, Math.max(1, Number(args.limit ?? 200)))
      const page = items.slice(0, limit)
      return ok(`${items.length} ${kind}`, {
        kind,
        items: page,
        count: items.length,
      }, { source: sources, truncated: items.length > page.length })
    }),
  ),

  defineTool(
    'ha_get_repairs',
    'List open repair issues (WebSocket diagnostics; falls back to UNSUPPORTED with a UI pointer).',
    {
      type: 'object',
      properties: {
        include_ignored: { type: 'boolean', description: 'Include ignored issues (default false).' },
      },
      additionalProperties: false,
    },
    guarded(async (args, sources) => {
      let raw
      try {
        raw = await haWs('repairs/list_issues')
      } catch (error) {
        if (error?.code === 'UNSUPPORTED') {
          throw new ToolError('UNSUPPORTED', `${error.message} Open Settings → System → Repairs in Home Assistant.`, {
            hint: 'The repairs WebSocket command is frontend-only and not available on this HA version.',
          })
        }
        throw error
      }
      sources.push('WS repairs/list_issues')
      const record = raw !== null && typeof raw === 'object' ? raw : {}
      let issues = Array.isArray(record.issues) ? record.issues : []
      if (args.include_ignored !== true) issues = issues.filter((issue) => issue?.is_ignored !== true)
      return ok(`${issues.length} open repairs`, { issues, count: issues.length }, { source: sources })
    }),
  ),

  defineTool(
    'ha_get_system_log',
    'Read the structured system log (WebSocket) with a plain error-log fallback.',
    {
      type: 'object',
      properties: {
        level: { type: 'string', enum: LOG_LEVELS, description: 'Minimum level to include.' },
        limit: { type: 'number', description: 'Max entries (default 50).' },
        since: { type: 'string', description: 'Only entries at/after this ISO timestamp.' },
      },
      additionalProperties: false,
    },
    guarded(async (args, sources) => {
      const limit = Math.min(500, Math.max(1, Number(args.limit ?? 50)))
      const minLevel = LOG_LEVELS.includes(args.level) ? args.level : undefined
      const since = asString(args.since)
      const processEntries = (entries) => {
        const minIndex = minLevel === undefined ? -1 : LOG_LEVELS.indexOf(minLevel)
        return entries
          .filter((entry) => {
            if (entry === null || typeof entry !== 'object') return false
            if (minIndex >= 0 && LOG_LEVELS.indexOf(String(entry.level ?? '').toLowerCase()) < minIndex) return false
            if (since !== undefined && typeof entry.timestamp === 'string' && entry.timestamp < since) return false
            return true
          })
          .slice(-limit)
      }
      try {
        const raw = await haWs('system_log/list')
        sources.push('WS system_log/list')
        const entries = processEntries(Array.isArray(raw) ? raw : [])
        return ok(`${entries.length} system log entries`, { entries, count: entries.length, fallback: false }, { source: sources })
      } catch (error) {
        if (error?.code !== 'UNSUPPORTED') throw error
        const data = await coreRequest('/error_log')
        sources.push(source('GET', '/error_log'))
        const text = typeof data === 'string' ? data : JSON.stringify(data)
        const entries = processEntries(
          text.split('\n').map((line) => {
            const match = /^(\S+ \S+)\s+(DEBUG|INFO|WARNING|ERROR|CRITICAL)\s+\(([^)]*)\)\s+\[([^\]]+)\]\s*(.*)$/.exec(line)
            if (match === null) return null
            return {
              timestamp: match[1].replace(' ', 'T'),
              level: match[2],
              source: match[3],
              name: match[4],
              message: match[5],
            }
          }).filter((entry) => entry !== null),
        )
        return ok(`${entries.length} log entries (error-log fallback)`, {
          entries,
          count: entries.length,
          fallback: true,
          unstructured_text_tail: text.split('\n').slice(-20),
        }, {
          source: sources,
          warnings: [
            {
              code: 'WS_UNSUPPORTED',
              message: 'system_log/list is not available; used GET /api/error_log instead (less structured).',
            },
          ],
        })
      }
    }),
  ),

  defineTool(
    'ha_get_automation_trace',
    'Read an automation trace (WebSocket) to see why a run did or did not happen.',
    {
      type: 'object',
      properties: {
        entity_id: { type: 'string', description: 'Automation entity id, e.g. automation.porch_lights.' },
        automation_id: { type: 'string', description: 'Automation numeric/string id if the entity id is unknown.' },
        run_id: { type: 'string', description: 'Specific trace run id; defaults to the most recent runs.' },
        limit: { type: 'number', description: 'How many recent runs to list (default 1).' },
      },
      additionalProperties: false,
    },
    guarded(async (args, sources) => {
      const entityId = asString(args.entity_id)
      const automationId = asString(args.automation_id)
      let domain = 'automation'
      let itemId = null
      if (entityId !== undefined) {
        const parts = entityId.split('.')
        domain = parts[0] ?? 'automation'
        itemId = parts.slice(1).join('.')
      } else if (automationId !== undefined) {
        itemId = automationId
      } else {
        return fail('INVALID_ARGUMENT', 'Pass either entity_id or automation_id.')
      }
      const runId = asString(args.run_id)
      const failUnsupported = (error) => {
        if (error?.code === 'UNSUPPORTED') {
          return new ToolError(
            'UNSUPPORTED',
            `${error.message} Open Settings → Tools → Traces in Home Assistant to inspect the run.`,
            { hint: 'The trace WebSocket commands are frontend-only and may be unavailable; the UI path always works.' },
          )
        }
        return error
      }
      if (runId !== undefined) {
        let trace
        try {
          trace = await haWs('trace/get', { domain, item_id: itemId, run_id: runId })
        } catch (error) {
          throw failUnsupported(error)
        }
        sources.push('WS trace/get')
        const serialised = JSON.stringify(trace ?? null)
        if (serialised.length > 30_000) {
          return ok(`Trace ${runId} (summary; full trace is large)`, {
            run_id: runId,
            summary: {
              run_id: runId,
              state: trace?.trace?.state ?? null,
              script_execution: trace?.trace?.script_execution ?? null,
              error: trace?.trace?.error ?? null,
            },
            full_trace_too_large: true,
          }, { source: sources, truncated: true })
        }
        return ok(`Trace ${runId}`, { run_id: runId, trace }, { source: sources })
      }
      let runs
      try {
        runs = await haWs('trace/list', { domain, item_id: itemId })
      } catch (error) {
        throw failUnsupported(error)
      }
      sources.push('WS trace/list')
      const limit = Math.min(20, Math.max(1, Number(args.limit ?? 1)))
      const list = Array.isArray(runs) ? runs : []
      const page = list.slice(-limit)
      return ok(`${page.length} recent trace(s)`, {
        entity_id: entityId ?? null,
        automation_id: itemId,
        runs: page,
        total_runs_available: list.length,
      }, { source: sources })
    }),
  ),
]

export { tools }
export default tools
