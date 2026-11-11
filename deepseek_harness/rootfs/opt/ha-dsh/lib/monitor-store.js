/**
 * Monitoring store: configuration, probe logic, findings history and the
 * deterministic daily digest.
 *
 * The probe is plain code over read-only HA/Supervisor endpoints: no model
 * calls, every request timeout-bounded, every failure collected instead of
 * thrown. State lives in `/data/monitor` (`config.json`, `state.json`,
 * `findings.jsonl`).
 *
 * @module monitor-store
 */

import { join } from 'node:path'
import { stat } from 'node:fs/promises'

import { getOptions, getPaths } from './paths.js'
import {
  ToolError,
  appendJsonl,
  isPlainObject,
  nowIso,
  readJson,
  readJsonl,
  writeJsonAtomic,
  writeTextAtomic,
} from './result.js'
import { errorLog, getStates, haOk } from './ha-core.js'
import { sup } from './supervisor.js'
import { inQuietHours, notifyUser } from './notify.js'

/** Monitor schema version. */
export const SCHEMA_VERSION = 1

/** Findings file rotation threshold. */
export const FINDINGS_MAX_BYTES = 1024 * 1024

/** Findings lines kept after rotation. */
export const FINDINGS_KEEP_LINES = 2000

/** Probe ring length (~6 days at 30 min). */
const PROBE_RING_MAX = 288

/** Number of probe ring entries kept even when probes are frequent. */
const SIGNATURE_MAX = 200
const UNAVAILABLE_ID_MAX = 500
const COOLDOWN_MAX_AGE_MS = 7 * 24 * 3600 * 1000
const FINDINGS_META_MAX_AGE_MS = 90 * 24 * 3600 * 1000

/** Default monitor configuration. */
export const DEFAULT_CONFIG = Object.freeze({
  version: SCHEMA_VERSION,
  enabled: true,
  quiet_hours: '',
  cooldown_hours: 6,
  max_notifications_per_hour: 3,
  digest_window_h: 24,
  deep_interval_h: 6,
  severity_min_notify: 2,
  updated_at: null,
  thresholds: Object.freeze({
    unavailable_ratio_warn: 0.1,
    unavailable_min_warn: 5,
    unavailable_ratio_crit: 0.25,
    unavailable_min_crit: 10,
    regression_min: 3,
    disk_free_ratio_crit: 0.05,
    disk_free_ratio_warn: 0.15,
    disk_free_gib_crit: 1,
    disk_free_gib_warn: 5,
    backup_age_warn_days: 7,
    backup_age_crit_days: 14,
    automation_stale_days: 7,
    updates_info_days: 14,
  }),
})

/** Logger patterns that raise severity on new error-log signatures. */
const CRITICAL_LOG_PATTERNS = [/no space left/i, /out of memory/i, /oom[- ]kill/i, /database disk image is malformed/i]
const SERIOUS_LOG_PATTERNS = [/failed to set up/i, /error setting up/i, /database is locked/i]

/** Emoji for the digest header by maximum severity. */
const SEVERITY_EMOJI = Object.freeze(['🟢', '🔵', '🟠', '🔴', '🚨'])

/** @returns {{config: string, state: string, findings: string}} */
export function monitorFiles() {
  const dir = getPaths().monitor
  return {
    config: join(dir, 'config.json'),
    state: join(dir, 'state.json'),
    findings: join(dir, 'findings.jsonl'),
  }
}

/** @param {unknown} value @param {number} fallback @param {number} min @param {number} max @returns {number} */
function clampNumber(value, fallback, min, max) {
  const number = Number(value)
  if (!Number.isFinite(number)) return fallback
  return Math.min(max, Math.max(min, number))
}

/** @returns {Promise<object>} configuration merged over defaults */
export async function readMonitorConfig() {
  const raw = await readJson(monitorFiles().config, null)
  const stored = isPlainObject(raw) ? raw : {}
  const options = getOptions()
  const thresholds = { ...DEFAULT_CONFIG.thresholds }
  if (isPlainObject(stored.thresholds)) {
    for (const key of Object.keys(thresholds)) {
      if (Number.isFinite(Number(stored.thresholds[key]))) thresholds[key] = Number(stored.thresholds[key])
    }
  }
  return {
    ...DEFAULT_CONFIG,
    ...stored,
    thresholds,
    enabled: stored.enabled === undefined ? options.monitorEnabled : stored.enabled === true,
    quiet_hours: typeof stored.quiet_hours === 'string' && stored.quiet_hours !== '' ? stored.quiet_hours : options.quietHours,
    cooldown_hours: clampNumber(stored.cooldown_hours, DEFAULT_CONFIG.cooldown_hours, 1, 72),
    max_notifications_per_hour: Math.trunc(clampNumber(stored.max_notifications_per_hour, DEFAULT_CONFIG.max_notifications_per_hour, 0, 20)),
    digest_window_h: Math.trunc(clampNumber(stored.digest_window_h, DEFAULT_CONFIG.digest_window_h, 1, 168)),
    deep_interval_h: clampNumber(stored.deep_interval_h, DEFAULT_CONFIG.deep_interval_h, 1, 168),
    severity_min_notify: Math.trunc(clampNumber(stored.severity_min_notify, DEFAULT_CONFIG.severity_min_notify, 0, 4)),
  }
}

/** Validate and persist a configuration patch. */
export async function configure(options = {}) {
  const current = await readMonitorConfig()
  const patch = options.patch
  if (patch === undefined || patch === null) {
    return { config: current }
  }
  if (!isPlainObject(patch)) throw new ToolError('INVALID_ARGUMENT', 'patch must be an object.')
  const next = { ...current, updated_at: nowIso() }
  const changed = []
  for (const [key, value] of Object.entries(patch)) {
    if (key === 'version' || key === 'updated_at') continue
    if (key === 'thresholds') {
      if (!isPlainObject(value)) throw new ToolError('INVALID_ARGUMENT', 'thresholds must be an object.')
      next.thresholds = { ...current.thresholds }
      for (const [thresholdKey, thresholdValue] of Object.entries(value)) {
        if (!(thresholdKey in DEFAULT_CONFIG.thresholds)) {
          throw new ToolError('INVALID_ARGUMENT', `Unknown threshold "${thresholdKey}".`, {
            hint: `Known thresholds: ${Object.keys(DEFAULT_CONFIG.thresholds).join(', ')}.`,
          })
        }
        const number = Number(thresholdValue)
        if (!Number.isFinite(number)) throw new ToolError('INVALID_ARGUMENT', `Threshold "${thresholdKey}" must be a number.`)
        next.thresholds[thresholdKey] = number
      }
      changed.push('thresholds')
      continue
    }
    if (!(key in DEFAULT_CONFIG)) {
      throw new ToolError('INVALID_ARGUMENT', `Unknown monitor setting "${key}".`, {
        hint: `Known settings: ${Object.keys(DEFAULT_CONFIG).filter((name) => name !== 'thresholds').join(', ')}, thresholds.`,
      })
    }
    if (key === 'enabled') {
      if (typeof value !== 'boolean') throw new ToolError('INVALID_ARGUMENT', 'enabled must be a boolean.')
    } else if (key === 'quiet_hours') {
      if (typeof value !== 'string') throw new ToolError('INVALID_ARGUMENT', 'quiet_hours must be "HH:MM-HH:MM" or empty.')
      if (value.trim() !== '' && !/^([01]?\d|2[0-3]):[0-5]\d-([01]?\d|2[0-3]):[0-5]\d$/.test(value.trim())) {
        throw new ToolError('INVALID_ARGUMENT', 'quiet_hours must look like "22:00-07:00".')
      }
      next.quiet_hours = value.trim()
    } else if (['cooldown_hours', 'max_notifications_per_hour', 'digest_window_h', 'deep_interval_h', 'severity_min_notify'].includes(key)) {
      const number = Number(value)
      if (!Number.isFinite(number)) throw new ToolError('INVALID_ARGUMENT', `${key} must be a number.`)
      next[key] = number
    }
    changed.push(key)
  }
  const normalised = await readMonitorConfigFrom(next)
  await writeJsonAtomic(monitorFiles().config, normalised)
  return { config: normalised, changed }
}

/** Validate a config-shaped object without touching disk. */
async function readMonitorConfigFrom(next) {
  const thresholds = { ...DEFAULT_CONFIG.thresholds, ...(isPlainObject(next.thresholds) ? next.thresholds : {}) }
  return {
    ...DEFAULT_CONFIG,
    ...next,
    thresholds,
    cooldown_hours: clampNumber(next.cooldown_hours, DEFAULT_CONFIG.cooldown_hours, 1, 72),
    max_notifications_per_hour: Math.trunc(clampNumber(next.max_notifications_per_hour, DEFAULT_CONFIG.max_notifications_per_hour, 0, 20)),
    digest_window_h: Math.trunc(clampNumber(next.digest_window_h, DEFAULT_CONFIG.digest_window_h, 1, 168)),
    deep_interval_h: clampNumber(next.deep_interval_h, DEFAULT_CONFIG.deep_interval_h, 1, 168),
    severity_min_notify: Math.trunc(clampNumber(next.severity_min_notify, DEFAULT_CONFIG.severity_min_notify, 0, 4)),
  }
}

/** @returns {Promise<object>} raw monitor state */
export async function readMonitorState() {
  const raw = await readJson(monitorFiles().state, null)
  const stored = isPlainObject(raw) ? raw : {}
  return {
    version: SCHEMA_VERSION,
    updated_at: typeof stored.updated_at === 'string' ? stored.updated_at : null,
    last_probe: typeof stored.last_probe === 'string' ? stored.last_probe : null,
    last_deep_probe: typeof stored.last_deep_probe === 'string' ? stored.last_deep_probe : null,
    last_digest: typeof stored.last_digest === 'string' ? stored.last_digest : null,
    last_alert_at: typeof stored.last_alert_at === 'string' ? stored.last_alert_at : null,
    core_fail_count: Number.isFinite(Number(stored.core_fail_count)) ? Number(stored.core_fail_count) : 0,
    baselines: isPlainObject(stored.baselines) ? stored.baselines : {},
    cooldowns: isPlainObject(stored.cooldowns) ? stored.cooldowns : {},
    findings_meta: isPlainObject(stored.findings_meta) ? stored.findings_meta : {},
    probe_ring: Array.isArray(stored.probe_ring) ? stored.probe_ring.filter((entry) => isPlainObject(entry)) : [],
  }
}

/** Persist monitor state, bounded to keep the file small. */
export async function writeMonitorState(state) {
  const now = Date.now()
  const cooldowns = {}
  for (const [key, entry] of Object.entries(state.cooldowns ?? {})) {
    const last = Date.parse(String(entry?.last_at ?? ''))
    if (Number.isFinite(last) && now - last <= COOLDOWN_MAX_AGE_MS) cooldowns[key] = entry
  }
  const findingsMeta = {}
  for (const [key, entry] of Object.entries(state.findings_meta ?? {})) {
    const last = Date.parse(String(entry?.last_seen ?? ''))
    if (Number.isFinite(last) && now - last <= FINDINGS_META_MAX_AGE_MS) findingsMeta[key] = entry
  }
  const baselines = isPlainObject(state.baselines) ? { ...state.baselines } : {}
  if (Array.isArray(baselines.unavailable_ids)) baselines.unavailable_ids = baselines.unavailable_ids.slice(0, UNAVAILABLE_ID_MAX)
  if (isPlainObject(baselines.signatures)) {
    const entries = Object.entries(baselines.signatures)
      .sort((a, b) => String(b[1]?.last_seen ?? '').localeCompare(String(a[1]?.last_seen ?? '')))
      .slice(0, SIGNATURE_MAX)
    baselines.signatures = Object.fromEntries(entries)
  }
  const bounded = {
    version: SCHEMA_VERSION,
    updated_at: nowIso(),
    last_probe: state.last_probe ?? null,
    last_deep_probe: state.last_deep_probe ?? null,
    last_digest: state.last_digest ?? null,
    last_alert_at: state.last_alert_at ?? null,
    core_fail_count: Number(state.core_fail_count ?? 0),
    baselines,
    cooldowns,
    findings_meta: findingsMeta,
    probe_ring: (state.probe_ring ?? []).slice(-PROBE_RING_MAX),
  }
  await writeJsonAtomic(monitorFiles().state, bounded)
  return bounded
}

/** Unwrap Supervisor `{result, data}` envelopes. */
function unwrap(payload) {
  if (isPlainObject(payload) && 'data' in payload && ('result' in payload || 'success' in payload)) return payload.data
  return payload
}

/**
 * Supervisor GET that throws `ToolError` on HTTP failure.
 * @param {string} path
 * @returns {Promise<unknown>}
 */
async function supGet(path) {
  const response = await sup(path, 'GET')
  if (!response.ok) {
    const message = isPlainObject(response.data) && typeof response.data.message === 'string'
      ? response.data.message
      : `Supervisor returned HTTP ${response.status} for ${path}`
    throw new ToolError('UPSTREAM_ERROR', message, { retryable: response.status >= 500 })
  }
  return unwrap(response.data)
}

/**
 * Normalise a log line into a stable signature: timestamps, UUIDs, hex values
 * and numbers are masked so a repeating error dedupes across probes.
 * @param {string} line
 * @returns {string}
 */
export function normalizeLogSignature(line) {
  let value = String(line).replace(/\x1b\[[0-9;]*m/g, '')
  value = value.replace(/\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})?/g, '<ts>')
  value = value.replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, '<uuid>')
  value = value.replace(/0x[0-9a-f]+/gi, '<hex>')
  value = value.replace(/\b\d+(?:\.\d+)?\b/g, '<n>')
  return value.replace(/\s+/g, ' ').trim().slice(0, 200)
}

/** @param {string} text @returns {Array<{signature: string, count: number, sample: string, critical: boolean}>} */
export function extractLogSignatures(text) {
  const lines = String(text ?? '').split('\n').filter((line) => /\b(ERROR|WARNING|CRITICAL)\b/.test(line))
  /** @type {Map<string, {signature: string, count: number, sample: string, critical: boolean}>} */
  const signatures = new Map()
  for (const line of lines.slice(-400)) {
    const signature = normalizeLogSignature(line)
    if (signature === '') continue
    const critical = CRITICAL_LOG_PATTERNS.some((pattern) => pattern.test(line))
    const previous = signatures.get(signature)
    signatures.set(signature, {
      signature,
      count: (previous?.count ?? 0) + 1,
      sample: line.trim().replace(/\s+/g, ' ').slice(0, 240),
      critical: critical || previous?.critical === true,
    })
  }
  return [...signatures.values()].slice(0, 50)
}

/**
 * Compute unavailable/unknown entity statistics from `/api/states`.
 * @param {unknown[]} states
 * @returns {{ total: number, unavailable: number, ratio: number, ids: string[], byDomain: Record<string, number> }}
 */
export function entityStats(states) {
  const list = Array.isArray(states) ? states : []
  const ids = []
  const byDomain = {}
  for (const state of list) {
    if (state?.state !== 'unavailable' && state?.state !== 'unknown') continue
    const id = String(state.entity_id ?? '')
    if (id === '') continue
    ids.push(id)
    const domain = id.split('.')[0] ?? 'unknown'
    byDomain[domain] = (byDomain[domain] ?? 0) + 1
  }
  ids.sort()
  return {
    total: list.length,
    unavailable: ids.length,
    ratio: list.length === 0 ? 0 : ids.length / list.length,
    ids,
    byDomain,
  }
}

/** @param {Date} date @returns {string} e.g. `Tue 11 Nov` */
function digestDate(date = new Date()) {
  const days = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
  return `${days[date.getDay()]} ${date.getDate()} ${months[date.getMonth()]}`
}

/** @param {string} iso @returns {number} */
function hoursSince(iso) {
  const parsed = Date.parse(String(iso ?? ''))
  if (!Number.isFinite(parsed)) return Number.POSITIVE_INFINITY
  return (Date.now() - parsed) / 3_600_000
}

/**
 * Evaluate read-only monitor signals and persist state.
 *
 * @param {{ deep?: boolean, notify?: boolean }} [options]
 * @returns {Promise<object>}
 */
export async function probe(options = {}) {
  const started = Date.now()
  const checkedAt = nowIso()
  const deep = options.deep === true
  const wantNotify = options.notify === true
  const config = await readMonitorConfig()
  const state = await readMonitorState()
  /** @type {object[]} */
  const signals = []
  /** @type {object[]} */
  const findings = []
  /** @type {object[]} */
  const notified = []
  /** @type {object[]} */
  const suppressed = []
  /** @type {object[]} */
  const errors = []
  /** @type {string[]} */
  const source = []
  const findingsToRecord = []
  const result = {
    checked_at: checkedAt,
    deep,
    enabled: config.enabled,
    max_severity: 0,
    signals,
    findings,
    notified,
    suppressed,
    errors,
    source,
    recorded: 0,
    duration_ms: 0,
  }
  if (!config.enabled) {
    result.skipped_reason = 'monitor_disabled'
    return result
  }

  const thresholds = config.thresholds

  /**
   * Record one evaluated signal and, when its severity is positive, a finding.
   * @param {string} check
   * @param {number} severity
   * @param {string} title
   * @param {string} detail
   * @param {{ signature?: string, confidence?: string, evidence?: string[] }} [extra]
   */
  const addSignal = (check, severity, title, detail, extra = {}) => {
    const clamped = Math.max(0, Math.min(4, Math.trunc(severity)))
    const entry = {
      check,
      severity: clamped,
      title: String(title).slice(0, 160),
      detail: String(detail).slice(0, 500),
      confidence: extra.confidence ?? 'medium',
    }
    signals.push(entry)
    result.max_severity = Math.max(result.max_severity, clamped)
    if (clamped === 0) return
    const id = extra.signature === undefined || extra.signature === '' ? check : `${check}:${extra.signature}`
    const previous = isPlainObject(state.findings_meta[id]) ? state.findings_meta[id] : null
    const meta = {
      first_seen: previous?.first_seen ?? checkedAt,
      last_seen: checkedAt,
      count: Number(previous?.count ?? 0) + 1,
      severity: Math.max(Number(previous?.severity ?? 0), clamped),
      last_recorded_at: previous?.last_recorded_at ?? null,
    }
    state.findings_meta[id] = meta
    const finding = {
      id,
      check,
      severity: clamped,
      title: entry.title,
      detail: entry.detail,
      evidence: Array.isArray(extra.evidence) ? extra.evidence.slice(0, 5) : [],
      confidence: entry.confidence,
      first_seen: meta.first_seen,
      last_seen: checkedAt,
      count: meta.count,
    }
    findings.push(finding)
    const cooldownMs = config.cooldown_hours * 3_600_000
    const lastRecorded = Date.parse(String(meta.last_recorded_at ?? ''))
    const shouldRecord = !Number.isFinite(lastRecorded)
      || clamped > Number(previous?.severity ?? 0)
      || Date.now() - lastRecorded >= cooldownMs
    if (shouldRecord) {
      meta.last_recorded_at = checkedAt
      if (findingsToRecord.length < 30) findingsToRecord.push({ ts: checkedAt, kind: 'finding', ...finding })
    }
  }

  // --- core.reachable -------------------------------------------------------
  let coreOk = false
  try {
    await haOk('/')
    coreOk = true
    state.core_fail_count = 0
    source.push('GET /core/api/')
    addSignal('core.reachable', 0, 'Home Assistant Core is responding', 'The Core REST API answered.')
  } catch (error) {
    coreOk = false
    state.core_fail_count = Number(state.core_fail_count ?? 0) + 1
    errors.push({ check: 'core.reachable', message: errorMessage(error) })
    addSignal(
      'core.reachable',
      state.core_fail_count >= 2 ? 4 : 2,
      'Home Assistant Core is not responding',
      `Core REST API request failed ${state.core_fail_count} probe(s) in a row: ${errorMessage(error)}`,
      { confidence: 'high' },
    )
  }

  // --- entities -------------------------------------------------------------
  let states = null
  if (coreOk) {
    try {
      const payload = await getStates()
      states = Array.isArray(payload) ? payload : []
      source.push('GET /core/api/states')
    } catch (error) {
      errors.push({ check: 'entities.unavailable', message: errorMessage(error) })
      addSignal('entities.unavailable', 3, 'Could not read entity states', errorMessage(error), { confidence: 'high' })
    }
  }
  if (states !== null) {
    const stats = entityStats(states)
    const baseline = state.baselines
    const baselineTotal = Number(baseline.unavailable_total ?? stats.unavailable)
    const baselineRatio = Number(baseline.unavailable_ratio ?? stats.ratio)
    const previousIds = Array.isArray(baseline.unavailable_ids) ? baseline.unavailable_ids : []
    const previousSet = new Set(previousIds)
    const newIds = stats.ids.filter((id) => !previousSet.has(id))
    const newByDomain = {}
    for (const id of newIds) {
      const domain = id.split('.')[0] ?? 'unknown'
      newByDomain[domain] = (newByDomain[domain] ?? 0) + 1
    }
    const topDomain = Object.entries(stats.byDomain).sort((a, b) => b[1] - a[1])[0]

    let unavailableSeverity = 0
    if (stats.ratio >= thresholds.unavailable_ratio_crit && stats.unavailable >= thresholds.unavailable_min_crit) unavailableSeverity = 4
    else if (stats.ratio >= thresholds.unavailable_ratio_warn && stats.unavailable >= thresholds.unavailable_min_warn) unavailableSeverity = 2
    else if (stats.unavailable - baselineTotal >= 3) unavailableSeverity = 2
    else if (stats.unavailable > baselineTotal) unavailableSeverity = 1
    const trend = stats.unavailable === baselineTotal
      ? 'unchanged from the previous probe'
      : stats.unavailable > baselineTotal
        ? `up from ${baselineTotal} at the previous probe`
        : `down from ${baselineTotal} at the previous probe`
    addSignal(
      'entities.unavailable',
      unavailableSeverity,
      `${stats.unavailable} of ${stats.total} entities are unavailable`,
      `${stats.unavailable} unavailable/unknown entities (${Math.round(stats.ratio * 100)}% of ${stats.total}), ${trend}. Baseline ${baselineTotal} (${Math.round(baselineRatio * 100)}%)${topDomain ? `; most affected domain: ${topDomain[0]} (${topDomain[1]})` : ''}.`,
      { confidence: 'high', signature: '', evidence: stats.ids.slice(0, 5) },
    )
    baseline.unavailable_total = stats.unavailable
    baseline.unavailable_ratio = Number(stats.ratio.toFixed(4))
    baseline.unavailable_by_domain = stats.byDomain
    baseline.unavailable_ids = stats.ids.slice(0, UNAVAILABLE_ID_MAX)
    baseline.entities_total = stats.total

    const domainEntries = Object.entries(newByDomain).sort((a, b) => b[1] - a[1])
    const worst = domainEntries[0]
    if (worst !== undefined && worst[1] >= thresholds.regression_min) {
      addSignal(
        'entities.regression',
        2,
        `${worst[1]} ${worst[0]} entities became unavailable`,
        `Newly unavailable since the previous probe: ${newIds.slice(0, 5).join(', ')}${newIds.length > 5 ? ` … (+${newIds.length - 5} more)` : ''}.`,
        { confidence: 'medium', signature: worst[0], evidence: newIds.slice(0, 5) },
      )
    } else if (newIds.length >= thresholds.regression_min) {
      addSignal(
        'entities.regression',
        1,
        `${newIds.length} entities became unavailable`,
        `Newly unavailable: ${newIds.slice(0, 5).join(', ')}${newIds.length > 5 ? ` … (+${newIds.length - 5} more)` : ''}.`,
        { confidence: 'medium', signature: 'mixed', evidence: newIds.slice(0, 5) },
      )
    }

    const staleDays = thresholds.automation_stale_days
    const staleAutomations = states.filter((state) => {
      const id = String(state?.entity_id ?? '')
      if (!id.startsWith('automation.')) return false
      if (state?.state !== 'on') return false
      const lastTriggered = state?.attributes?.last_triggered
      if (typeof lastTriggered === 'string' && Number.isFinite(Date.parse(lastTriggered))) {
        return hoursSince(lastTriggered) > staleDays * 24
      }
      const lastUpdated = Date.parse(String(state?.last_updated ?? ''))
      return Number.isFinite(lastUpdated) && (Date.now() - lastUpdated) / 86_400_000 > staleDays
    })
    addSignal(
      'automations.stale',
      staleAutomations.length > 0 ? 1 : 0,
      `${staleAutomations.length} enabled automations may be stale`,
      staleAutomations.length === 0
        ? 'All enabled automations triggered recently or were updated recently.'
        : `No trigger recorded in ${staleDays}+ days for: ${staleAutomations.slice(0, 5).map((state) => state.entity_id).join(', ')}. Heuristic: an automation can be intentionally quiet.`,
      { confidence: 'low', signature: String(staleAutomations.length) },
    )
  }

  // --- backups --------------------------------------------------------------
  try {
    const payload = unwrap(await supGet('/backups/info'))
    const backups = Array.isArray(payload?.backups) ? payload.backups : []
    const dates = backups
      .map((backup) => String(backup?.date ?? backup?.created_at ?? ''))
      .filter((date) => date !== '' && Number.isFinite(Date.parse(date)))
      .sort()
    const newest = dates.at(-1) ?? null
    const ageDays = newest === null ? Number.POSITIVE_INFINITY : (Date.now() - Date.parse(newest)) / 86_400_000
    const daysUntilStale = Number.isFinite(Number(payload?.days_until_stale)) ? Number(payload.days_until_stale) : null
    let severity = 0
    if (ageDays > thresholds.backup_age_crit_days || (daysUntilStale !== null && daysUntilStale < 0)) severity = 3
    else if (ageDays > thresholds.backup_age_warn_days) severity = 2
    addSignal(
      'backups.fresh',
      severity,
      ageDays === Number.POSITIVE_INFINITY ? 'No backup found' : `Newest backup is ${Math.floor(ageDays)} days old`,
      newest === null
        ? 'The Supervisor reports no backups; create one before the next risky change.'
        : `Newest backup ${newest} (${Math.floor(ageDays)} days old)${daysUntilStale === null ? '' : `, ${daysUntilStale} days until stale`}.`,
      { confidence: 'high', signature: '' },
    )
    state.baselines.backups_newest = newest
    state.baselines.backups_days_until_stale = daysUntilStale
  } catch (error) {
    errors.push({ check: 'backups.fresh', message: errorMessage(error) })
  }

  // --- updates --------------------------------------------------------------
  try {
    const payload = unwrap(await supGet('/available_updates'))
    const updates = Array.isArray(payload?.available_updates) ? payload.available_updates : Array.isArray(payload) ? payload : []
    addSignal(
      'updates',
      updates.length > 0 ? 1 : 0,
      updates.length > 0 ? `${updates.length} update(s) available` : 'No updates available',
      updates.length === 0
        ? 'Core, Supervisor, OS and apps are current.'
        : `Available: ${updates.slice(0, 6).map((update) => `${update?.name ?? update?.entity_id ?? 'update'} ${update?.version ?? ''}`.trim()).join('; ')}${updates.length > 6 ? ` … (+${updates.length - 6} more)` : ''}. Check release notes before updating.`,
      { confidence: 'high', signature: String(updates.length) },
    )
  } catch (error) {
    errors.push({ check: 'updates', message: errorMessage(error) })
  }

  // --- apps health ----------------------------------------------------------
  try {
    const payload = unwrap(await supGet('/addons'))
    const addons = Array.isArray(payload?.addons) ? payload.addons : Array.isArray(payload) ? payload : []
    const errored = addons.filter((addon) => addon?.state === 'error')
    const stoppedAuto = addons.filter((addon) => addon?.state === 'stopped' && addon?.boot === 'auto')
    const slugs = [...errored, ...stoppedAuto].map((addon) => String(addon?.slug ?? '')).filter((slug) => slug !== '')
    let severity = 0
    if (errored.length > 0) severity = 3
    else if (stoppedAuto.length > 0) severity = 3
    addSignal(
      'apps.health',
      severity,
      severity === 0 ? 'Apps are healthy' : `${slugs.length} app(s) need attention`,
      severity === 0
        ? `All ${addons.length} installed apps are running or intentionally stopped.`
        : `Apps not running: ${slugs.slice(0, 6).join(', ')}. Read the app Log tab for crash details.`,
      { confidence: 'high', signature: slugs.slice(0, 3).sort().join(',') },
    )
  } catch (error) {
    errors.push({ check: 'apps.health', message: errorMessage(error) })
  }

  // --- disk -----------------------------------------------------------------
  try {
    const payload = unwrap(await supGet('/host/info'))
    const free = Number(payload?.disk_free)
    const total = Number(payload?.disk_total)
    if (Number.isFinite(free) && Number.isFinite(total) && total > 0) {
      const ratio = free / total
      const freeGib = free > 1_000_000 ? free / 1024 ** 3 : free
      const totalGib = total > 1_000_000 ? total / 1024 ** 3 : total
      let severity = 0
      if (ratio < thresholds.disk_free_ratio_crit || freeGib < thresholds.disk_free_gib_crit) severity = 4
      else if (ratio < thresholds.disk_free_ratio_warn || freeGib < thresholds.disk_free_gib_warn) severity = 2
      addSignal(
        'disk',
        severity,
        severity === 0 ? 'Disk space is fine' : `Disk ${Math.round(ratio * 100)}% free`,
        `${freeGib.toFixed(1)} GiB free of ${totalGib.toFixed(1)} GiB (${Math.round(ratio * 100)}%). The recorder database needs free space at least its own size.`,
        { confidence: 'high', signature: `${Math.floor(ratio * 20)}` },
      )
      state.baselines.disk_free = free
      state.baselines.disk_total = total
    }
  } catch (error) {
    errors.push({ check: 'disk', message: errorMessage(error) })
  }

  // --- deep signals: error log + resolution --------------------------------
  if (deep) {
    if (coreOk) {
      try {
        const text = await errorLog()
        source.push('GET /core/api/error_log')
        const signatures = extractLogSignatures(text)
        const known = isPlainObject(state.baselines.signatures) ? state.baselines.signatures : {}
        const fresh = signatures.filter((signature) => !(signature.signature in known))
        const critical = fresh.filter((signature) => signature.critical)
        const serious = fresh.filter((signature) => SERIOUS_LOG_PATTERNS.some((pattern) => pattern.test(signature.sample)))
        let severity = 0
        if (critical.length > 0) severity = 4
        else if (serious.length > 0) severity = 3
        else if (fresh.length > 0) severity = 2
        const freshText = fresh.slice(0, 5).map((signature) => `\`${signature.sample}\``).join('; ')
        addSignal(
          'log.new_errors',
          severity,
          fresh.length === 0 ? 'No new error-log signatures' : `${fresh.length} new error-log signature(s)`,
          fresh.length === 0
            ? `Scanned the error log; all ${signatures.length} signatures were already known.`
            : `New since the last deep probe: ${freshText}${fresh.length > 5 ? ` … (+${fresh.length - 5} more)` : ''}.`,
          { confidence: 'medium', signature: normalizeLogSignature(fresh[0]?.signature ?? 'none').slice(0, 80) },
        )
        state.baselines.signatures = known
        for (const signature of signatures) {
          const previous = known[signature.signature]
          known[signature.signature] = {
            count: Number(previous?.count ?? 0) + signature.count,
            last_seen: checkedAt,
          }
        }
        state.baselines.log_signatures_seen = Object.keys(known).length
      } catch (error) {
        errors.push({ check: 'log.new_errors', message: errorMessage(error) })
      }
    }
    try {
      const payload = unwrap(await supGet('/resolution/info'))
      const unhealthy = Array.isArray(payload?.unhealthy) ? payload.unhealthy : []
      const unsupported = Array.isArray(payload?.unsupported) ? payload.unsupported : []
      const issues = Array.isArray(payload?.issues) ? payload.issues : []
      let severity = 0
      if (unhealthy.length > 0) severity = 3
      else if (unsupported.length > 0 || issues.length > 0) severity = 2
      addSignal(
        'resolution',
        severity,
        severity === 0 ? 'Supervisor resolution is healthy' : 'Supervisor reports a system problem',
        severity === 0
          ? 'No unhealthy or unsupported reasons reported.'
          : `Unhealthy: ${unhealthy.join(', ') || 'none'}; unsupported: ${unsupported.join(', ') || 'none'}; open issues: ${issues.slice(0, 5).map((issue) => issue?.type ?? issue).join(', ') || 'none'}.`,
        { confidence: 'high', signature: [...unhealthy, ...unsupported].sort().join(',') },
      )
    } catch (error) {
      errors.push({ check: 'resolution', message: errorMessage(error) })
    }
  }

  // --- notifications --------------------------------------------------------
  const now = Date.now()
  const cooldownMs = config.cooldown_hours * 3_600_000
  for (const finding of findings) {
    if (finding.severity < config.severity_min_notify) continue
    const cooldown = state.cooldowns[finding.id]
    if (isPlainObject(cooldown)) {
      const last = Date.parse(String(cooldown.last_at ?? ''))
      if (Number.isFinite(last) && now - last < cooldownMs && finding.severity < Number(cooldown.severity ?? 0) + 1) {
        suppressed.push({
          key: finding.id,
          reason: 'cooldown',
          severity: finding.severity,
          last_at: cooldown.last_at,
          cooldown_hours: config.cooldown_hours,
        })
        continue
      }
    }
    if (!wantNotify) continue
    const delivery = await notifyUser({
      title: `Home Assistant monitor: ${finding.title}`,
      message: `${finding.detail}`,
      severity: finding.severity,
      dedupe_key: `monitor:${finding.id}`,
      quiet_hours: config.quiet_hours,
      max_per_hour: config.max_notifications_per_hour,
      throttle_ms: cooldownMs,
    })
    if (delivery.delivered.length > 0) {
      state.cooldowns[finding.id] = { last_at: checkedAt, severity: finding.severity }
      state.last_alert_at = checkedAt
      notified.push({ key: finding.id, severity: finding.severity, channels: delivery.delivered })
    } else {
      suppressed.push({
        key: finding.id,
        severity: finding.severity,
        reasons: delivery.suppressed,
        quiet_hours: delivery.quiet_hours,
      })
    }
  }

  // --- persist --------------------------------------------------------------
  state.last_probe = checkedAt
  if (deep) state.last_deep_probe = checkedAt
  state.probe_ring = [...(state.probe_ring ?? []), {
    ts: checkedAt,
    severity: result.max_severity,
    findings: findings.length,
    ok: errors.length === 0,
  }].slice(-PROBE_RING_MAX)

  for (const entry of findingsToRecord) {
    try {
      await appendJsonl(monitorFiles().findings, entry)
    } catch (error) {
      errors.push({ check: 'findings', message: errorMessage(error) })
    }
  }
  result.recorded = findingsToRecord.length
  await rotateFindings()
  try {
    await writeMonitorState(state)
  } catch (error) {
    errors.push({ check: 'state', message: errorMessage(error) })
  }
  result.findings = findings
  result.duration_ms = Date.now() - started
  return result
}

/** Rotate `findings.jsonl` when it grows past the budget. */
async function rotateFindings() {
  const file = monitorFiles().findings
  let size = 0
  try {
    size = (await stat(file)).size
  } catch {
    return
  }
  if (size < FINDINGS_MAX_BYTES) return
  const lines = await readJsonl(file)
  const kept = lines.slice(-FINDINGS_KEEP_LINES)
  await writeTextAtomic(file, kept.map((line) => `${JSON.stringify(line)}\n`).join(''))
}

/**
 * Read findings history, newest first.
 * @param {{ since?: string|number, severity_min?: number, limit?: number, kinds?: string[] }} [options]
 * @returns {Promise<object[]>}
 */
export async function readFindings(options = {}) {
  const entries = await readJsonl(monitorFiles().findings)
  const severityMin = Number.isFinite(Number(options.severity_min)) ? Number(options.severity_min) : 0
  const limit = Number.isFinite(Number(options.limit)) ? Math.max(1, Number(options.limit)) : 50
  let sinceMs = Number.NEGATIVE_INFINITY
  if (typeof options.since === 'number' && Number.isFinite(options.since)) {
    sinceMs = Date.now() - Math.max(0, options.since) * 3_600_000
  } else if (typeof options.since === 'string' && options.since !== '') {
    const parsed = Date.parse(options.since)
    if (Number.isFinite(parsed)) sinceMs = parsed
  }
  const kinds = Array.isArray(options.kinds) ? new Set(options.kinds) : null
  return entries
    .filter((entry) => isPlainObject(entry))
    .filter((entry) => (entry.kind ?? 'finding') === 'finding' || (kinds !== null && kinds.has(entry.kind)))
    .filter((entry) => Number(entry.severity ?? 0) >= severityMin)
    .filter((entry) => {
      const ts = Date.parse(String(entry.ts ?? ''))
      return Number.isFinite(ts) ? ts >= sinceMs : sinceMs === Number.NEGATIVE_INFINITY
    })
    .sort((a, b) => String(b.ts ?? '').localeCompare(String(a.ts ?? '')))
    .slice(0, limit)
}

/**
 * Findings history formatted for the `monitor_history` tool.
 * @param {{ since?: string|number, severity_min?: number, limit?: number }} [options]
 * @returns {Promise<object>}
 */
export async function history(options = {}) {
  const findings = await readFindings(options)
  return {
    count: findings.length,
    since: options.since ?? null,
    severity_min: Number.isFinite(Number(options.severity_min)) ? Number(options.severity_min) : 0,
    findings,
  }
}

/** @param {object} finding @returns {number} attention score (ha-domain §5.2) */
function attentionScore(finding) {
  const confidenceBonus = finding.confidence === 'high' ? 2 : finding.confidence === 'low' ? -1 : 0
  return Number(finding.severity ?? 0) * 10 + confidenceBonus
}

/**
 * Render the deterministic daily digest (≤20 lines, Markdown, 0 LLM calls).
 * @param {{ send?: boolean, window_h?: number }} [options]
 * @returns {Promise<object>}
 */
export async function digest(options = {}) {
  const config = await readMonitorConfig()
  const state = await readMonitorState()
  const windowH = Math.trunc(clampNumber(options.window_h, config.digest_window_h, 1, 168))
  const since = new Date(Date.now() - windowH * 3_600_000).toISOString()
  const entries = await readFindings({ since, severity_min: 0, limit: 500 })
  const findings = entries.filter((entry) => (entry.kind ?? 'finding') === 'finding')

  /** @type {Map<string, object>} */
  const aggregated = new Map()
  for (const finding of findings) {
    const id = String(finding.id ?? finding.check ?? 'unknown')
    const previous = aggregated.get(id)
    if (previous === undefined) {
      aggregated.set(id, {
        id,
        severity: Number(finding.severity ?? 0),
        title: String(finding.title ?? finding.check ?? 'finding'),
        detail: String(finding.detail ?? ''),
        count: 1,
        last_seen: String(finding.ts ?? ''),
        confidence: finding.confidence ?? 'medium',
      })
      continue
    }
    previous.count += 1
    previous.severity = Math.max(previous.severity, Number(finding.severity ?? 0))
    if (String(finding.ts ?? '') >= previous.last_seen) {
      previous.title = String(finding.title ?? previous.title)
      previous.detail = String(finding.detail ?? previous.detail)
      previous.last_seen = String(finding.ts ?? previous.last_seen)
    }
  }
  const open = [...aggregated.values()]
  const maxSeverity = open.reduce((max, finding) => Math.max(max, finding.severity), 0)
  const attention = open
    .filter((finding) => finding.severity >= 2)
    .sort((a, b) => attentionScore(b) - attentionScore(a) || a.id.localeCompare(b.id))
    .slice(0, 5)
  const probes = (state.probe_ring ?? []).filter((entry) => Date.parse(String(entry?.ts ?? '')) >= Date.parse(since)).length

  const lines = []
  lines.push(`${SEVERITY_EMOJI[maxSeverity] ?? SEVERITY_EMOJI[0]} Home Assistant — daily check, ${digestDate()}`)
  lines.push('')
  if (open.length === 0) {
    lines.push('Status: all clear — no findings in this window.')
  } else {
    lines.push(`Status: ${attention.length} thing${attention.length === 1 ? '' : 's'} need attention, ${open.length} open finding${open.length === 1 ? '' : 's'}.`)
  }
  lines.push(`Since the last ${windowH} h: ${probes} probe${probes === 1 ? '' : 's'}, ${findings.length} finding record${findings.length === 1 ? '' : 's'}.`)
  if (attention.length > 0) {
    lines.push('')
    lines.push('Needs attention:')
    attention.forEach((finding, index) => {
      const label = finding.severity >= 4 ? 'critical' : finding.severity >= 3 ? 'serious' : 'warning'
      const detail = finding.detail.replace(/`/g, '').replace(/\s+/g, ' ').slice(0, 140)
      lines.push(`${index + 1}. [${label}] ${finding.title.replace(/`/g, '')}${detail === '' ? '' : ` — ${detail}`}`)
    })
  }
  lines.push('')
  const backups = state.baselines?.backups_newest
  const backupText = typeof backups === 'string' && backups !== ''
    ? `latest backup ${backups.slice(0, 10)}`
    : 'no backup information yet'
  const unavailable = state.baselines?.entities_total
    ? `${state.baselines.unavailable_total ?? 0} of ${state.baselines.entities_total} entities unavailable`
    : 'entities not collected yet'
  lines.push(`Quiet: ${backupText}; ${unavailable}.`)
  lines.push('Details: Settings → System → Logs; ask me to dig into any numbered item.')
  const trimmed = lines.slice(0, 20)
  const markdown = trimmed.join('\n')
  const base = {
    markdown,
    lines: trimmed.length,
    window_h: windowH,
    findings_count: findings.length,
    open_count: open.length,
    needs_attention: attention.map((finding) => ({ id: finding.id, severity: finding.severity, title: finding.title })),
    max_severity: maxSeverity,
    since,
  }

  const sent = { sent: false, delivered: [], suppressed: [], skipped_reason: null }
  if (options.send === true) {
    const allClear = attention.length === 0 && maxSeverity < 2
    const recentAlert = typeof state.last_alert_at === 'string' && hoursSince(state.last_alert_at) < 24
    if (allClear && !recentAlert) {
      sent.skipped_reason = 'all_clear_no_recent_alert'
    } else {
      const delivery = await notifyUser({
        title: 'Home Assistant — daily check',
        message: markdown,
        severity: Math.max(2, maxSeverity),
        dedupe_key: `digest:${new Date().toISOString().slice(0, 10)}`,
        quiet_hours: config.quiet_hours,
        max_per_hour: config.max_notifications_per_hour,
      })
      sent.sent = delivery.delivered.length > 0
      sent.delivered = delivery.delivered
      sent.suppressed = delivery.suppressed
      sent.quiet_hours = delivery.quiet_hours
    }
  }

  const now = nowIso()
  try {
    await appendJsonl(monitorFiles().findings, {
      ts: now,
      kind: 'digest',
      window_h: windowH,
      max_severity: maxSeverity,
      open_count: open.length,
      lines: trimmed.length,
      sent: sent.sent,
      channels: sent.delivered,
    })
    await rotateFindings()
  } catch {
    // a digest that cannot be recorded is still a delivered digest
  }
  state.last_digest = now
  try {
    await writeMonitorState(state)
  } catch {
    // state failure must not hide the digest
  }
  return { ...base, ...sent, recorded_at: now }
}

/** @param {unknown} error @returns {string} */
function errorMessage(error) {
  return error instanceof Error ? error.message : String(error)
}

// re-exported so tool modules do not need to import notify.js separately
export { inQuietHours }
