/**
 * First-run system recognition.
 *
 * Runs once per installation, before the web UI starts:
 *
 *  1. Deterministically collects the Home Assistant inventory (versions,
 *     integrations, entities, automations, apps, backups) — no LLM calls.
 *  2. Writes a human-readable `FIRST-RUN.md` into the agent workspace
 *     (`/config/deepseek-harness`), which Home Assistant backups include.
 *  3. When LLM credentials are available, runs one `dsh headless` assessment
 *     session that inspects the live system with the plugin tools, writes the
 *     report and leaves a persisted session the web UI can open by default.
 *     The session id is exported to the ingress shim through
 *     `/data/runtime/default-session.json`.
 *
 * Failures never block the add-on: the deterministic report is written first,
 * and a marker prevents endless retries.
 *
 * @module first-run
 */

import { spawn } from 'node:child_process'
import { appendFile, mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import { getOptions, getPaths, VERSION } from '../lib/paths.js'
import { recordChange, readMemory, refreshCollected } from '../lib/memory-store.js'
import { nowIso, writeTextAtomic } from '../lib/result.js'

const MARKER_NAME = 'first-run.json'
const MAX_ATTEMPTS = 3
const DEFAULT_TIMEOUT_MS = 240_000
const REPORT_NAME = 'FIRST-RUN.md'
const AGENT_REPORT_NAME = 'FIRST-RUN-REPORT.md'

/** @param {string} message */
function log(message) {
  const line = `${new Date().toISOString()} [first-run] ${message}`
  process.stdout.write(`${line}\n`)
  const logFile = join(getPaths().dshHome, 'addon.log')
  void appendFile(logFile, `${line}\n`).catch(() => {})
}

/** Whether any LLM credential source is likely available. */
async function hasCredentials() {
  if (typeof process.env.DEEPSEEK_API_KEY === 'string' && process.env.DEEPSEEK_API_KEY.trim() !== '') return true
  try {
    const credentials = await readFile(join(getPaths().dshHome, '.credentials.yaml'), 'utf8')
    const trimmed = credentials.trim()
    if (trimmed === '' || trimmed === '{}' || trimmed === 'null') return false
    // Only a credential-shaped document counts; the plain scaffold file must
    // not trigger a doomed model call on every boot.
    return /(?:api[_-]?key|token|secret)\s*:\s*["']?[A-Za-z0-9._-]{8,}/i.test(trimmed)
  } catch {
    return false
  }
}

/** Render the deterministic first-run report from the collected memory. */
function renderReport(memory, collectedAt) {
  const collected = memory.memory?.collected ?? {}
  const versions = collected.versions ?? {}
  const host = collected.host ?? {}
  const integrations = collected.integrations ?? {}
  const entities = collected.entities ?? {}
  const apps = Array.isArray(collected.apps) ? collected.apps : []
  const updates = Array.isArray(collected.updates) ? collected.updates : []
  const backups = collected.backups ?? {}
  const automations = Array.isArray(collected.automations) ? collected.automations : []
  const configFiles = Array.isArray(collected.config_files) ? collected.config_files : []
  const unavailable = Number.isFinite(Number(entities.unavailable)) ? Number(entities.unavailable) : 'unknown'
  const lines = [
    '# DeepSeek Harness — first-run system recognition',
    '',
    `- Generated: ${nowIso()}`,
    `- Add-on version: ${VERSION}`,
    `- Inventory collected: ${collectedAt ?? 'unknown'}`,
    '',
    '## Versions',
    '',
    `- Home Assistant Core: ${versions.ha ?? 'unknown'}`,
    `- Supervisor: ${versions.supervisor ?? 'unknown'}`,
    `- Operating System: ${versions.os ?? 'unknown'}`,
    `- Channel: ${versions.channel ?? 'unknown'}`,
    '',
    '## Host',
    '',
    `- Machine: ${host.machine ?? 'unknown'} (${host.arch ?? 'unknown'})`,
    `- Disk free: ${host.disk_free_gib ?? 'unknown'} GiB of ${host.disk_total_gib ?? 'unknown'} GiB`,
    '',
    '## Integrations and entities',
    '',
    `- Integrations: ${integrations.count ?? 'unknown'} (custom: ${integrations.custom_count ?? 'unknown'})`,
    `- Entities: ${entities.total ?? 'unknown'} total, ${unavailable} unavailable`,
    `- Automations: ${automations.length}`,
    `- Config files tracked: ${configFiles.length}`,
    '',
    '## Apps (add-ons)',
    '',
  ]
  if (apps.length === 0) {
    lines.push('No apps reported.')
  } else {
    lines.push('| App | Version | State | Update available |', '|---|---|---|---|')
    for (const app of apps.slice(0, 100)) {
      lines.push(
        `| ${app.name ?? app.slug ?? 'unknown'} | ${app.version ?? '?'} | ${app.state ?? '?'} | ${
          app.update_available === true ? 'yes' : 'no'
        } |`,
      )
    }
  }
  lines.push('', '## Updates and backups', '')
  lines.push(`- Pending updates: ${updates.length}`)
  for (const update of updates.slice(0, 30)) {
    lines.push(`  - ${update.name ?? update.slug ?? 'update'}: ${update.version_latest ?? '?'}`)
  }
  lines.push(`- Backups: ${backups.count ?? 'unknown'}; newest: ${backups.newest ?? 'unknown'}; days until stale: ${backups.days_until_stale ?? 'unknown'}`)
  lines.push('', '## Next step', '')
  lines.push(
    'This report was produced deterministically, without a model call. Ask the agent to inspect any area, or enable the first-run analysis (API key required) for a narrative assessment.',
    '',
  )
  return lines.join('\n')
}

/** Build the task prompt for the LLM first-run assessment. */
function analysisTask() {
  return [
    'This is the first start of the DeepSeek Harness add-on for Home Assistant.',
    'Perform a system recognition of the installation and report it to the user.',
    '',
    'Steps:',
    '1. Call memory_get and, if the collected inventory is stale, memory_refresh.',
    '2. Inspect the live system with the Home Assistant tools: ha_get_config, ha_get_states (summarise counts and unavailable entities), ha_get_config_check, sup_list_addons, sup_get_updates, sup_backup_list, sup_get_resolution.',
    '3. Identify the most important issues (unavailable entities, failing config check, missing or stale backups, apps that are stopped or have updates, supervisor unhealthy/unsupported reasons).',
    '4. Write a concise Markdown report to /config/deepseek-harness/FIRST-RUN-REPORT.md with sections: System summary, Apps, Health, Backups, Recommended next steps. Keep it under 120 lines.',
    '5. Reply with a short summary for the user (what the system looks like, the top 3 findings, and one question about what they want to improve first).',
    '',
    'Do not change any Home Assistant configuration in this first-run assessment; read-only tools only.',
  ].join('\n')
}

/**
 * Run one headless analysis session and return its id and final text.
 * @param {string} task
 * @param {number} timeoutMs
 * @returns {Promise<{ sessionId: string, text: string } | null>}
 */
async function runAnalysis(task, timeoutMs) {
  const workspace = getPaths().workspace
  await mkdir(workspace, { recursive: true })
  const args = [
    'headless',
    '--patch',
    '/opt/ha-dsh/profile.patch.yml',
    '--patch',
    '/opt/ha-dsh/plugin/cordis.patch.yml',
    '--json',
    task,
  ]
  log('starting first-run analysis session (this may take a minute)')
  return await new Promise((resolve) => {
    /** @type {import('node:child_process').ChildProcess} */
    let child
    try {
      child = spawn('dsh', args, {
        cwd: workspace,
        env: {
          ...process.env,
          DSH_PERMISSION_MODE: 'workspace-write',
          DSH_ADDON_VERSION: VERSION,
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      })
    } catch (error) {
      log(`first-run analysis could not start: ${error instanceof Error ? error.message : String(error)}`)
      resolve(null)
      return
    }
    let sessionId = ''
    let finalText = ''
    let buffer = ''
    let stderrTail = ''
    /** @param {string} line */
    const consume = (line) => {
      if (line.trim() === '') return
      try {
        const event = JSON.parse(line)
        if (event?.type === 'session' && typeof event.sessionId === 'string') sessionId = event.sessionId
        if (event?.type === 'final') {
          sessionId = typeof event.sessionId === 'string' ? event.sessionId : sessionId
          finalText = typeof event.text === 'string' ? event.text : finalText
        }
      } catch {
        // Non-JSON output (rare) is ignored; the final answer comes from --json.
      }
    }
    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (chunk) => {
      buffer += chunk
      let index = buffer.indexOf('\n')
      while (index !== -1) {
        consume(buffer.slice(0, index))
        buffer = buffer.slice(index + 1)
        index = buffer.indexOf('\n')
      }
    })
    child.stderr.setEncoding('utf8')
    child.stderr.on('data', (chunk) => {
      stderrTail = `${stderrTail}${chunk}`.slice(-4000)
    })
    const timer = setTimeout(() => {
      log(`first-run analysis exceeded ${timeoutMs} ms; cancelling`)
      child.kill('SIGTERM')
    }, timeoutMs)
    child.on('error', (error) => {
      clearTimeout(timer)
      log(`first-run analysis failed to start: ${error.message}`)
      resolve(null)
    })
    child.on('close', (code, signal) => {
      clearTimeout(timer)
      if (buffer.trim() !== '') consume(buffer)
      if (sessionId !== '' && finalText !== '') {
        log(`first-run analysis finished (session ${sessionId})`)
        resolve({ sessionId, text: finalText })
        return
      }
      log(
        `first-run analysis did not produce a session (code=${code ?? 'null'} signal=${signal ?? 'null'}): ${stderrTail
          .split('\n')
          .slice(-6)
          .join(' | ')}`,
      )
      resolve(null)
    })
  })
}

/** Read the marker, or a default shape when absent. */
async function readMarker(markerPath) {
  try {
    const parsed = JSON.parse(await readFile(markerPath, 'utf8'))
    return parsed && typeof parsed === 'object' ? parsed : {}
  } catch {
    return {}
  }
}

/**
 * Entry point used by `runtime/entrypoint.mjs`.
 * @returns {Promise<void>}
 */
export async function runFirstRun() {
  const paths = getPaths()
  const options = getOptions()
  const markerPath = join(paths.data, MARKER_NAME)
  const marker = await readMarker(markerPath)
  // A completed analysis is final. A deterministic-only marker (no credentials,
  // option disabled, or failed attempt) is retried on later boots once the
  // conditions are met, so adding an API key does not require wiping /data.
  if (marker.done === true && marker.llm === true) return
  if (marker.done === true && marker.llm !== true) {
    if (!getOptions().firstRunAnalysis) return
    if (!(await hasCredentials())) return
  }

  if (marker.llm === false && Number(marker.attempts ?? 0) >= MAX_ATTEMPTS) {
    log('first-run recognition already completed (deterministic report only); skipping')
    return
  }

  log('first-run recognition: collecting system inventory (no model calls)')
  let memory
  try {
    await refreshCollected()
    memory = await readMemory({ max_age_hours: 1 })
  } catch (error) {
    log(`inventory collection failed: ${error instanceof Error ? error.message : String(error)}`)
    return
  }

  const collectedAt = memory?.memory?.collected?.collected_at ?? null
  const report = renderReport(memory, collectedAt)
  const reportPath = join(paths.workspace, REPORT_NAME)
  try {
    await writeTextAtomic(reportPath, report, 0o644)
    log(`wrote deterministic report: ${reportPath}`)
  } catch (error) {
    log(`could not write ${reportPath}: ${error instanceof Error ? error.message : String(error)}`)
  }
  try {
    await recordChange({
      kind: 'first-run',
      summary: 'First-run system recognition completed (deterministic inventory).',
      at: nowIso(),
    })
  } catch {
    // Changelog is best-effort.
  }

  const credentials = await hasCredentials()
  if (!options.firstRunAnalysis) {
    log('first-run analysis disabled by add-on option; deterministic report is ready')
    await writeFile(markerPath, `${JSON.stringify({ done: true, llm: false, reason: 'disabled', completedAt: nowIso() }, null, 2)}\n`)
    return
  }
  if (!credentials) {
    log('no LLM credentials available yet; deterministic report is ready, analysis will retry after a key is configured')
    await writeFile(
      markerPath,
      `${JSON.stringify({ done: false, llm: false, reason: 'no-credentials', attempts: marker.attempts ?? 0, completedAt: nowIso() }, null, 2)}\n`,
    )
    return
  }

  const timeoutMs = Number.parseInt(process.env.DSH_FIRST_RUN_TIMEOUT ?? String(DEFAULT_TIMEOUT_MS), 10)
  const analysis = await runAnalysis(analysisTask(), Number.isFinite(timeoutMs) ? timeoutMs : DEFAULT_TIMEOUT_MS)
  if (analysis === null) {
    const attempts = Number(marker.attempts ?? 0) + 1
    await writeFile(
      markerPath,
      `${JSON.stringify({ done: false, llm: false, reason: 'analysis-failed', attempts, completedAt: nowIso() }, null, 2)}\n`,
    )
    return
  }

  try {
    await writeTextAtomic(join(paths.workspace, AGENT_REPORT_NAME), `${analysis.text}\n`, 0o644)
    log(`wrote agent report: ${join(paths.workspace, AGENT_REPORT_NAME)}`)
  } catch (error) {
    log(`could not write agent report: ${error instanceof Error ? error.message : String(error)}`)
  }

  await mkdir(join(paths.data, 'runtime'), { recursive: true })
  const defaultSession = {
    sessionId: analysis.sessionId,
    source: 'first-run',
    createdAt: nowIso(),
  }
  await writeFile(join(paths.data, 'runtime', 'default-session.json'), `${JSON.stringify(defaultSession, null, 2)}\n`)
  await writeFile(
    markerPath,
    `${JSON.stringify({ done: true, llm: true, sessionId: analysis.sessionId, completedAt: nowIso() }, null, 2)}\n`,
  )
  try {
    await recordChange({
      kind: 'first-run',
      summary: `First-run analysis session created (${analysis.sessionId}).`,
      at: nowIso(),
    })
  } catch {
    // best effort
  }
  log(`first-run recognition complete; default session ${analysis.sessionId}`)
}

/** Whether the marker exists and the analysis is complete (diagnostics/tests). */
export async function firstRunDone() {
  const marker = await readMarker(join(getPaths().data, MARKER_NAME))
  return marker.done === true
}

