/**
 * Persistent agent memory under `/data/memory`.
 *
 * Two ownership domains (see docs/research/ha-domain.md §6.3):
 * - `collected` is written only by deterministic collection code (`refreshCollected`);
 * - `curated` is written only by `updateMemory` (the `memory_update` tool) and is
 *   revision-guarded (CAS) and bounded.
 *
 * Files:
 * - `system.json`   structured memory `{schema_version, revision, updated_at, collected, curated}`
 * - `system.md`     human-readable, secret-free rendering safe to show the user
 * - `changelog.jsonl` append-only durable change log, rotated at 2 MB
 * - `backups.json`  backup ledger (§4.13)
 * - `baselines.json` compact baseline snapshot shared with monitoring
 *
 * @module memory-store
 */

import { randomBytes } from 'node:crypto'
import { join } from 'node:path'
import { stat } from 'node:fs/promises'

import { getPaths } from './paths.js'
import {
  ToolError,
  appendJsonl,
  isPlainObject,
  nowIso,
  readJson,
  readJsonl,
  redact,
  stableStringify,
  writeJsonAtomic,
  writeTextAtomic,
} from './result.js'
import { haOk } from './ha-core.js'
import { sup } from './supervisor.js'

/** Current structured-memory schema version. */
export const SCHEMA_VERSION = 1

/** Curated domain byte budget (32 KB of JSON). */
export const CURATED_MAX_BYTES = 32 * 1024

/** Curated domain entry budget (arrays + object keys across buckets). */
export const CURATED_MAX_ENTRIES = 200

/** Changelog rotation threshold. */
export const CHANGELOG_MAX_BYTES = 2 * 1024 * 1024

/** Lines kept after a changelog rotation. */
export const CHANGELOG_KEEP_LINES = 5000

/** Upper bound for `system.md`, so a corrupt curated value cannot bloat it. */
export const SYSTEM_MD_MAX_BYTES = 64 * 1024

/** Curated buckets owned by the model/user (ha-domain.md §6.5). */
export const CURATED_BUCKETS = Object.freeze([
  'preferences',
  'hardware',
  'quirks',
  'incidents',
  'intent',
  'do_not_touch',
  'open_tasks',
  'backup_policy',
])

/** Buckets stored as arrays of entries. */
const LIST_BUCKETS = Object.freeze(['preferences', 'hardware', 'quirks', 'incidents', 'do_not_touch', 'open_tasks'])

/** Buckets stored as objects. */
const OBJECT_BUCKETS = Object.freeze(['intent', 'backup_policy'])

/** Backups kept in the ledger. */
const BACKUPS_MAX_ENTRIES = 200

/** @returns {{system: string, systemMd: string, changelog: string, backups: string, baselines: string}} */
export function memoryFiles() {
  const dir = getPaths().memory
  return {
    system: join(dir, 'system.json'),
    systemMd: join(dir, 'system.md'),
    changelog: join(dir, 'changelog.jsonl'),
    backups: join(dir, 'backups.json'),
    baselines: join(dir, 'baselines.json'),
  }
}

/** Fresh default curated memory. */
export function defaultCurated() {
  return {
    preferences: [],
    hardware: [],
    quirks: [],
    incidents: [],
    intent: {},
    do_not_touch: [],
    open_tasks: [],
    backup_policy: { weekly: true, retention: 5 },
  }
}

/** @param {unknown} value @returns {boolean} */
function isStringArray(value) {
  return Array.isArray(value) && value.every((item) => typeof item === 'string')
}

/**
 * Normalise a stored curated object: keep known buckets, fill defaults, drop
 * malformed values (a corrupted file must not break every tool).
 * @param {unknown} raw
 * @returns {object}
 */
export function normalizeCurated(raw) {
  const base = defaultCurated()
  if (!isPlainObject(raw)) return base
  for (const bucket of LIST_BUCKETS) {
    if (isStringArray(raw[bucket])) base[bucket] = raw[bucket].map((text) => sanitizeText(text)).filter((text) => text !== '')
  }
  if (Array.isArray(raw.quirks)) {
    base.quirks = raw.quirks
      .map((item) => {
        if (typeof item === 'string') return { id: makeQuirkId([]), text: sanitizeText(item), added: today(), resolved: null }
        if (!isPlainObject(item)) return null
        const text = sanitizeText(String(item.text ?? ''))
        if (text === '') return null
        return {
          id: typeof item.id === 'string' && item.id !== '' ? item.id.slice(0, 64) : makeQuirkId([]),
          text,
          added: typeof item.added === 'string' ? item.added.slice(0, 32) : today(),
          resolved: typeof item.resolved === 'string' ? item.resolved.slice(0, 32) : null,
        }
      })
      .filter((item) => item !== null)
  }
  for (const bucket of OBJECT_BUCKETS) {
    if (isPlainObject(raw[bucket])) {
      const out = {}
      for (const [key, value] of Object.entries(raw[bucket])) {
        if (value === null || ['string', 'number', 'boolean'].includes(typeof value)) {
          out[sanitizeText(key).slice(0, 200)] = typeof value === 'string' ? sanitizeText(value).slice(0, 4000) : value
        } else if (bucket === 'intent' && typeof value === 'string') {
          out[key] = sanitizeText(value)
        }
      }
      base[bucket] = out
    }
  }
  if (isPlainObject(raw.do_not_touch)) base.do_not_touch = []
  return base
}

/** @param {unknown[]} existingIds @returns {string} */
function makeQuirkId(existingIds) {
  const taken = new Set(existingIds.map((id) => String(id)))
  for (;;) {
    const id = `q_${randomBytes(3).toString('hex')}`
    if (!taken.has(id)) return id
  }
}

/** @returns {string} local date `YYYY-MM-DD` */
function today(date = new Date()) {
  const pad = (value) => String(value).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
}

/**
 * Mask values that look like secrets. Curated memory must never store tokens,
 * passwords or API keys; this is the last line of defence for chat pastes.
 * @param {string} text
 * @returns {string}
 */
export function sanitizeText(text) {
  let value = String(text ?? '')
  value = value.replace(/\bBearer\s+[A-Za-z0-9._\-+/=]{8,}/g, 'Bearer [redacted]')
  value = value.replace(
    /\b(password|passwd|token|secret|api[ _-]?key|authorization)\b(\s*[:=]\s*)(\S{4,})/gi,
    (_match, key, separator) => `${key}${separator}[redacted]`,
  )
  value = value.replace(/\b[A-Za-z0-9+/_-]{40,}={0,2}\b/g, '[redacted]')
  return value.replace(/\s+/g, ' ').trim()
}

/**
 * Count curated entries: one per list item, one per object key, and one per
 * quirk (quirks are objects inside the quirks list).
 * @param {object} curated
 * @returns {number}
 */
export function countCuratedEntries(curated) {
  let count = 0
  for (const bucket of LIST_BUCKETS) count += Array.isArray(curated[bucket]) ? curated[bucket].length : 0
  for (const bucket of OBJECT_BUCKETS) count += isPlainObject(curated[bucket]) ? Object.keys(curated[bucket]).length : 0
  return count
}

/** @param {object} curated @returns {number} bytes of the curated JSON */
export function curatedBytes(curated) {
  return Buffer.byteLength(JSON.stringify(curated), 'utf8')
}

/** @param {unknown} value @param {string} fallback @returns {string} */
function asString(value, fallback = '') {
  return typeof value === 'string' && value !== '' ? value : fallback
}

/**
 * Load `system.json`, tolerating a missing or corrupted file.
 * @returns {Promise<{ memory: object, exists: boolean }>}
 */
export async function loadMemory() {
  const files = memoryFiles()
  const raw = await readJson(files.system, null)
  const exists = isPlainObject(raw)
  const collected = isPlainObject(raw?.collected) ? raw.collected : { collected_at: null }
  if (!('collected_at' in collected)) collected.collected_at = null
  return {
    exists,
    memory: {
      schema_version: SCHEMA_VERSION,
      revision: Number.isInteger(raw?.revision) && raw.revision >= 0 ? raw.revision : 0,
      updated_at: typeof raw?.updated_at === 'string' ? raw.updated_at : null,
      collected,
      curated: normalizeCurated(raw?.curated),
    },
  }
}

/**
 * Read memory ready for the model.
 * @param {{
 *   sections?: string[], fresh?: boolean, max_age_hours?: number,
 *   changelog_limit?: number, backups_limit?: number,
 * }} [options]
 * @returns {Promise<object>}
 */
export async function readMemory(options = {}) {
  const { memory, exists } = await loadMemory()
  const maxAgeHours = Number.isFinite(Number(options.max_age_hours)) ? Number(options.max_age_hours) : 24
  const changelogLimit = Number.isFinite(Number(options.changelog_limit)) ? Math.max(0, Number(options.changelog_limit)) : 20
  const backupsLimit = Number.isFinite(Number(options.backups_limit)) ? Math.max(0, Number(options.backups_limit)) : 20

  const stale = []
  if (!exists) stale.push('memory')
  const collectedAt = asString(memory.collected?.collected_at, '')
  if (collectedAt === '') {
    stale.push('collected')
  } else if (options.fresh !== true) {
    const ageHours = (Date.now() - Date.parse(collectedAt)) / 3_600_000
    if (!Number.isFinite(ageHours) || ageHours > maxAgeHours) stale.push('collected')
  }

  const changelog_tail = changelogLimit > 0 ? (await readChangelog(changelogLimit)).reverse() : []
  const backups = await readBackups(backupsLimit)
  const curated = memory.curated

  const full = {
    schema_version: memory.schema_version,
    revision: memory.revision,
    updated_at: memory.updated_at,
    stale,
    collected: memory.collected,
    curated,
    changelog_tail,
    backups,
    summary: {
      curated_entries: countCuratedEntries(curated),
      curated_bytes: curatedBytes(curated),
      curated_limits: { bytes: CURATED_MAX_BYTES, entries: CURATED_MAX_ENTRIES },
      collected_at: collectedAt === '' ? null : collectedAt,
      open_quirks: curated.quirks.filter((quirk) => quirk.resolved === null).length,
    },
  }

  const sections = Array.isArray(options.sections) && options.sections.length > 0 ? options.sections : null
  if (sections === null) return full
  const wanted = new Set(sections)
  /** @type {Record<string, unknown>} */
  const filtered = {
    schema_version: full.schema_version,
    revision: full.revision,
    updated_at: full.updated_at,
    stale: filteredStale(full.stale, wanted),
  }
  if (wanted.has('collected')) filtered.collected = full.collected
  if (wanted.has('curated')) filtered.curated = full.curated
  if (wanted.has('summary')) filtered.summary = full.summary
  if (wanted.has('changelog') || wanted.has('changelog_tail')) filtered.changelog_tail = full.changelog_tail
  if (wanted.has('backups')) filtered.backups = full.backups
  return filtered
}

/** @param {string[]} stale @param {Set<string>} wanted @returns {string[]} */
function filteredStale(stale, wanted) {
  return stale.filter((section) => section === 'memory' || wanted.has('collected'))
}

/**
 * Apply curated operations.
 * @param {{
 *   ops: Array<Record<string, unknown>>, reason?: string,
 *   base_revision?: number, collected?: unknown,
 * }} options
 * @returns {Promise<object>}
 */
export async function updateMemory(options = {}) {
  const { ops, reason, base_revision } = options
  if (options.collected !== undefined) {
    throw new ToolError('FORBIDDEN', 'Collected memory is written only by deterministic collection. Use memory_refresh instead.', {
      hint: 'Call memory_refresh to re-collect the inventory; use memory_update only for curated notes.',
    })
  }
  if (!Array.isArray(ops) || ops.length === 0) {
    throw new ToolError('INVALID_ARGUMENT', 'memory_update needs at least one op.', {
      hint: 'Supported ops: set, append, add_quirk, resolve_quirk, record_change, record_backup.',
    })
  }
  if (ops.length > 50) throw new ToolError('INVALID_ARGUMENT', 'At most 50 ops per call.')

  const { memory } = await loadMemory()
  if (base_revision !== undefined && base_revision !== null) {
    if (!Number.isInteger(base_revision)) throw new ToolError('INVALID_ARGUMENT', 'base_revision must be an integer.')
    if (base_revision !== memory.revision) {
      throw new ToolError('CONFLICT', `Memory revision changed: expected ${base_revision}, current is ${memory.revision}.`, {
        hint: 'Call memory_get, apply the change again against the current revision and content.',
        data: { revision: memory.revision, updated_at: memory.updated_at },
      })
    }
  }

  const curated = JSON.parse(JSON.stringify(memory.curated))
  /** @type {string[]} */
  const changed = []
  /** @type {Array<Record<string, unknown>>} */
  const changelogEntries = []
  /** @type {Array<Record<string, unknown>>} */
  const backupEntries = []

  for (const rawOp of ops) {
    if (!isPlainObject(rawOp) || typeof rawOp.op !== 'string') {
      throw new ToolError('INVALID_ARGUMENT', 'Each op must be an object with an `op` field.')
    }
    const op = rawOp.op
    if (op === 'set') applySet(curated, rawOp, changed)
    else if (op === 'append') applyAppend(curated, rawOp, changed)
    else if (op === 'add_quirk') applyAddQuirk(curated, rawOp, changed)
    else if (op === 'resolve_quirk') applyResolveQuirk(curated, rawOp, changed, changelogEntries)
    else if (op === 'record_change') {
      const entry = normalizeChangeEntry(rawOp.entry ?? rawOp)
      changelogEntries.push(entry)
      changed.push('record_change')
    } else if (op === 'record_backup') {
      const entry = normalizeBackupEntry(rawOp.entry ?? rawOp)
      backupEntries.push(entry)
      changelogEntries.push({ ts: entry.ts ?? nowIso(), kind: 'backup', ...entry })
      changed.push('record_backup')
    } else {
      throw new ToolError('INVALID_ARGUMENT', `Unknown memory op "${op}".`, {
        hint: 'Supported ops: set, append, add_quirk, resolve_quirk, record_change, record_backup.',
      })
    }
  }

  const bytes = curatedBytes(curated)
  const entries = countCuratedEntries(curated)
  if (bytes > CURATED_MAX_BYTES) {
    throw new ToolError('INVALID_ARGUMENT', `Curated memory would be ${bytes} bytes; the limit is ${CURATED_MAX_BYTES}.`, {
      hint: 'Move long incident narratives into record_change entries or archive resolved quirks.',
      data: { bytes, limit: CURATED_MAX_BYTES },
    })
  }
  if (entries > CURATED_MAX_ENTRIES) {
    throw new ToolError('INVALID_ARGUMENT', `Curated memory would have ${entries} entries; the limit is ${CURATED_MAX_ENTRIES}.`, {
      hint: 'Resolve quirks and prune completed open tasks.',
      data: { entries, limit: CURATED_MAX_ENTRIES },
    })
  }

  memory.revision += 1
  memory.updated_at = nowIso()
  memory.curated = curated
  const files = memoryFiles()
  await writeJsonAtomic(files.system, memory)

  if (typeof reason === 'string' && reason.trim() !== '') {
    changelogEntries.unshift({
      ts: memory.updated_at,
      kind: 'memory_update',
      reason: sanitizeText(reason).slice(0, 500),
      ops: ops.map((op) => op.op),
      revision: memory.revision,
    })
  }
  for (const entry of changelogEntries) await appendChangelogEntry(entry)
  if (backupEntries.length > 0) await appendBackups(backupEntries)
  await writeBaselinesFromCollected(memory.collected)
  // Re-render after the changelog append so system.md shows the newest entries.
  await writeTextAtomic(files.systemMd, await renderSystemMd(memory))

  return {
    revision: memory.revision,
    updated_at: memory.updated_at,
    changed,
    curated_bytes: bytes,
    entries,
    changelog_appended: changelogEntries.length,
    backups_appended: backupEntries.length,
    limits: { bytes: CURATED_MAX_BYTES, entries: CURATED_MAX_ENTRIES },
  }
}

/** @param {object} curated @param {Record<string, unknown>} op @param {string[]} changed */
function applySet(curated, op, changed) {
  const key = String(op.key ?? '')
  if (key === '') throw new ToolError('INVALID_ARGUMENT', 'set requires `key` (e.g. "preferences" or "intent.automation.porch").')
  const parts = key.split('.')
  const bucket = parts[0]
  if (bucket === 'collected') throw new ToolError('FORBIDDEN', 'Collected memory cannot be edited with memory_update.')
  if (!CURATED_BUCKETS.includes(bucket)) {
    throw new ToolError('INVALID_ARGUMENT', `Unknown curated bucket "${bucket}".`, {
      hint: `Use one of: ${CURATED_BUCKETS.join(', ')}.`,
    })
  }
  if (op.value === undefined) throw new ToolError('INVALID_ARGUMENT', 'set requires `value`.')
  const cleaned = redact(op.value)
  if (parts.length === 1) {
    if (LIST_BUCKETS.includes(bucket)) {
      if (!Array.isArray(cleaned)) throw new ToolError('INVALID_ARGUMENT', `Bucket "${bucket}" is a list; set an array or use append.`)
      curated[bucket] = normalizeListValue(bucket, cleaned)
    } else {
      if (!isPlainObject(cleaned)) throw new ToolError('INVALID_ARGUMENT', `Bucket "${bucket}" is an object.`)
      curated[bucket] = normalizeObjectValue(bucket, cleaned)
    }
    changed.push(`set ${bucket}`)
    return
  }
  if (parts.length !== 2) throw new ToolError('INVALID_ARGUMENT', 'Nested set supports at most one dot: "intent.<entity_id>".')
  if (!OBJECT_BUCKETS.includes(bucket)) {
    throw new ToolError('INVALID_ARGUMENT', `Nested set is only supported for ${OBJECT_BUCKETS.join(', ')}.`)
  }
  if (typeof cleaned !== 'string' && typeof cleaned !== 'number' && typeof cleaned !== 'boolean') {
    throw new ToolError('INVALID_ARGUMENT', 'Nested values must be strings, numbers or booleans.')
  }
  const subKey = parts[1]
  if (subKey === '') throw new ToolError('INVALID_ARGUMENT', 'Nested key is empty.')
  curated[bucket][sanitizeText(subKey).slice(0, 200)] = typeof cleaned === 'string' ? sanitizeText(cleaned).slice(0, 4000) : cleaned
  changed.push(`set ${bucket}.${subKey}`)
}

/** @param {object} curated @param {Record<string, unknown>} op @param {string[]} changed */
function applyAppend(curated, op, changed) {
  const rawBucket = String(op.key ?? op.bucket ?? '')
  if (rawBucket === '') throw new ToolError('INVALID_ARGUMENT', 'append requires `key` (a list bucket).')
  const bucket = rawBucket.split('.')[0]
  if (bucket === 'collected') throw new ToolError('FORBIDDEN', 'Collected memory cannot be edited with memory_update.')
  if (!LIST_BUCKETS.includes(bucket)) {
    throw new ToolError('INVALID_ARGUMENT', `append requires a list bucket: ${LIST_BUCKETS.join(', ')}.`)
  }
  if (bucket === 'quirks') {
    applyAddQuirk(curated, { op: 'add_quirk', text: op.text }, changed)
    return
  }
  const text = sanitizeText(String(op.text ?? '')).slice(0, 2000)
  if (text === '') throw new ToolError('INVALID_ARGUMENT', 'append requires non-empty `text`.')
  if (!curated[bucket].includes(text)) {
    curated[bucket].push(text)
    changed.push(`append ${bucket}`)
  } else {
    changed.push(`append ${bucket} (duplicate skipped)`)
  }
  if (curated[bucket].length > 100) throw new ToolError('INVALID_ARGUMENT', `Bucket "${bucket}" already has 100 entries.`)
}

/** @param {object} curated @param {Record<string, unknown>} op @param {string[]} changed */
function applyAddQuirk(curated, op, changed) {
  const text = sanitizeText(String(op.text ?? '')).slice(0, 2000)
  if (text === '') throw new ToolError('INVALID_ARGUMENT', 'add_quirk requires non-empty `text`.')
  const duplicate = curated.quirks.find((quirk) => quirk.text === text && quirk.resolved === null)
  if (duplicate !== undefined) {
    changed.push('add_quirk (duplicate skipped)')
    return
  }
  const id = typeof op.id === 'string' && /^q_[a-z0-9_]{1,40}$/.test(op.id)
    ? op.id
    : makeQuirkId(curated.quirks.map((quirk) => quirk.id))
  curated.quirks.push({ id, text, added: today(), resolved: null })
  changed.push(`add_quirk ${id}`)
}

/** @param {object} curated @param {Record<string, unknown>} op @param {string[]} changed @param {object[]} changelog */
function applyResolveQuirk(curated, op, changed, changelog) {
  const id = String(op.id ?? '')
  const quirk = curated.quirks.find((item) => item.id === id)
  if (quirk === undefined) throw new ToolError('NOT_FOUND', `No quirk with id "${id}".`, { hint: 'Call memory_get with sections ["curated"] to list quirk ids.' })
  if (quirk.resolved !== null) {
    changed.push(`resolve_quirk ${id} (already resolved)`)
    return
  }
  quirk.resolved = nowIso()
  changed.push(`resolve_quirk ${id}`)
  changelog.push({ ts: quirk.resolved, kind: 'quirk_resolved', id, text: quirk.text })
}

/** @param {unknown} raw @returns {object} */
function normalizeChangeEntry(raw) {
  if (!isPlainObject(raw)) throw new ToolError('INVALID_ARGUMENT', 'record_change requires an `entry` object.')
  const entry = { ...redact(raw) }
  entry.ts = typeof entry.ts === 'string' ? entry.ts : nowIso()
  entry.kind = typeof entry.kind === 'string' ? sanitizeText(entry.kind).slice(0, 60) : 'change'
  if (typeof entry.reason === 'string') entry.reason = sanitizeText(entry.reason).slice(0, 500)
  const bytes = Buffer.byteLength(JSON.stringify(entry), 'utf8')
  if (bytes > 4000) throw new ToolError('INVALID_ARGUMENT', 'Changelog entries are limited to 4000 bytes.', { data: { bytes } })
  return entry
}

/** @param {unknown} raw @returns {object} */
function normalizeBackupEntry(raw) {
  if (!isPlainObject(raw)) throw new ToolError('INVALID_ARGUMENT', 'record_backup requires an `entry` object.')
  const entry = { ...redact(raw) }
  entry.ts = typeof entry.ts === 'string' ? entry.ts : nowIso()
  entry.kind = 'backup'
  if (typeof entry.slug === 'string') entry.slug = sanitizeText(entry.slug).slice(0, 200)
  if (typeof entry.name === 'string') entry.name = sanitizeText(entry.name).slice(0, 200)
  if (typeof entry.reason === 'string') entry.reason = sanitizeText(entry.reason).slice(0, 200)
  if (typeof entry.verified_at === 'string') entry.verified_at = entry.verified_at.slice(0, 40)
  return entry
}

/** @param {string} bucket @param {unknown[]} values @returns {string[]} */
function normalizeListValue(bucket, values) {
  return values
    .map((value) => {
      if (typeof value === 'string') return sanitizeText(value).slice(0, 2000)
      if (isPlainObject(value) && bucket === 'quirks') {
        const text = sanitizeText(String(value.text ?? '')).slice(0, 2000)
        if (text === '') return ''
        return text
      }
      return ''
    })
    .filter((value) => value !== '')
}

/** @param {string} bucket @param {object} value @returns {object} */
function normalizeObjectValue(bucket, value) {
  const out = {}
  for (const [key, item] of Object.entries(value)) {
    if (bucket === 'intent') {
      if (typeof item !== 'string') continue
      out[sanitizeText(key).slice(0, 200)] = sanitizeText(item).slice(0, 2000)
      continue
    }
    if (item === null || ['string', 'number', 'boolean'].includes(typeof item)) {
      out[sanitizeText(key).slice(0, 200)] = typeof item === 'string' ? sanitizeText(item).slice(0, 2000) : item
    }
  }
  return out
}

/**
 * Run deterministic collection and persist the `collected` domain.
 * @param {(() => Promise<{collected: object, source?: string[], errors?: object[]}>)|undefined} [collector]
 * @returns {Promise<object>}
 */
export async function refreshCollected(collector) {
  const run = typeof collector === 'function' ? collector : () => collectSystem()
  const collectedAt = nowIso()
  let outcome
  try {
    outcome = await run()
  } catch (error) {
    outcome = { collected: null, source: [], errors: [{ section: 'collector', message: error instanceof Error ? error.message : String(error) }] }
  }
  const source = Array.isArray(outcome?.source) ? outcome.source : []
  const errors = Array.isArray(outcome?.errors) ? outcome.errors : []
  const collected = isPlainObject(outcome?.collected) ? boundCollected(outcome.collected) : null

  const { memory } = await loadMemory()
  const previous = memory.collected
  let changed = false
  let changedSections = []
  let nextCollected = previous
  if (collected !== null) {
    // A failed section must not erase previously collected data: merge over the
    // previous snapshot and let freshly fetched sections win.
    nextCollected = { ...previous, ...collected, collected_at: collectedAt }
    const beforeSections = Object.keys(previous).filter((key) => key !== 'collected_at')
    const afterSections = Object.keys(nextCollected).filter((key) => key !== 'collected_at')
    const all = new Set([...beforeSections, ...afterSections])
    changedSections = [...all].filter((key) => stableStringify(previous[key]) !== stableStringify(nextCollected[key])).sort()
    changed = changedSections.length > 0
    memory.collected = nextCollected
  }
  const diff = {
    changed,
    changed_sections: changedSections,
    versions_before: summarizeVersions(previous),
    versions_after: summarizeVersions(nextCollected),
    counts: summarizeCounts(nextCollected),
  }
  if (changed) {
    memory.revision += 1
    memory.updated_at = collectedAt
  }
  const files = memoryFiles()
  await writeJsonAtomic(files.system, memory)
  await writeTextAtomic(files.systemMd, await renderSystemMd(memory))
  await writeBaselinesFromCollected(memory.collected)
  if (changed) {
    await appendChangelogEntry({
      ts: collectedAt,
      kind: 'collected_refresh',
      changed_sections: changedSections,
      revision: memory.revision,
    })
  }
  return {
    revision: memory.revision,
    updated_at: memory.updated_at,
    collected_at: memory.collected?.collected_at ?? null,
    changed,
    diff,
    source,
    errors,
    stale: [],
  }
}

/** @param {unknown} collected @returns {{ha: string|null, supervisor: string|null, os: string|null}} */
function summarizeVersions(collected) {
  const versions = isPlainObject(collected) && isPlainObject(collected.versions) ? collected.versions : {}
  return {
    ha: asString(versions.ha, '') || null,
    supervisor: asString(versions.supervisor, '') || null,
    os: asString(versions.os, '') || null,
  }
}

/** @param {unknown} collected @returns {object} */
function summarizeCounts(collected) {
  if (!isPlainObject(collected)) return {}
  return {
    integrations: Number(collected.integrations?.count ?? 0),
    entities_total: Number(collected.entities?.total ?? 0),
    entities_unavailable: Number(collected.entities?.unavailable ?? 0),
    automations: Array.isArray(collected.automations) ? collected.automations.length : 0,
    apps: Array.isArray(collected.apps) ? collected.apps.length : 0,
    backups: Number(collected.backups?.count ?? 0),
  }
}

/** Keep collected data bounded; `system.json` should stay well under 128 KB. */
function boundCollected(collected) {
  const out = { ...collected }
  const cap = (list, max) => (Array.isArray(list) ? list.slice(0, max) : list)
  out.automations = cap(out.automations, 100)
  out.apps = cap(out.apps, 100)
  out.updates = isPlainObject(out.updates)
    ? { ...out.updates, updates: cap(out.updates.updates, 50) }
    : out.updates
  if (isPlainObject(out.entities) && isPlainObject(out.entities.by_domain)) {
    const entries = Object.entries(out.entities.by_domain).sort((a, b) => Number(b[1]) - Number(a[1])).slice(0, 25)
    out.entities = { ...out.entities, by_domain: Object.fromEntries(entries) }
  }
  if (isPlainObject(out.config_files)) out.config_files = cap(out.config_files, 50)
  if (Array.isArray(out.config_files)) out.config_files = out.config_files.slice(0, 50)
  let json = JSON.stringify(out)
  if (json.length > 120_000) {
    out.automations = Array.isArray(out.automations) ? out.automations.length : 0
    out.apps = Array.isArray(out.apps) ? out.apps.length : 0
    json = JSON.stringify(out)
  }
  return out
}

/** Unwrap Supervisor `{result, data}` envelopes. */
function unwrap(payload) {
  if (isPlainObject(payload) && 'data' in payload && ('result' in payload || 'success' in payload)) return payload.data
  return payload
}

/**
 * Supervisor GET that throws on HTTP failure and returns the unwrapped body.
 * @param {string} path
 * @returns {Promise<unknown>}
 */
async function supData(path) {
  const response = await sup(path, 'GET')
  if (!response.ok) {
    const message = isPlainObject(response.data) && typeof response.data.message === 'string'
      ? response.data.message
      : `Supervisor returned HTTP ${response.status} for ${path}`
    throw new ToolError('UPSTREAM_ERROR', message, { retryable: response.status >= 500 })
  }
  return unwrap(response.data)
}

/** @returns {Promise<{collected: object, source: string[], errors: object[]}>} */
export async function collectSystem(options = {}) {
  const requested = Array.isArray(options.sections) && options.sections.length > 0 ? options.sections : null
  const want = (section) => requested === null || requested.includes(section) || requested.includes('full') || requested.includes('all')
  /** @type {object} */
  const collected = {}
  /** @type {string[]} */
  const source = []
  /** @type {object[]} */
  const errors = []

  /** @param {string} section @param {() => Promise<unknown>} fn */
  const attempt = async (section, fn) => {
    try {
      return await fn()
    } catch (error) {
      errors.push({ section, message: error instanceof Error ? error.message : String(error) })
      return undefined
    }
  }

  const config = want('versions') || want('integrations')
    ? await attempt('config', async () => {
      const payload = await haOk('/config')
      source.push('GET /core/api/config')
      return isPlainObject(payload) ? payload : {}
    })
    : undefined

  if (want('versions')) {
    const versions = { ha: null, supervisor: null, os: null }
    versions.ha = asString(config?.version, '') || null
    const core = await attempt('versions.core', () => supData('/core/info'))
    if (versions.ha === null && isPlainObject(core)) versions.ha = asString(core.version, '') || null
    const supervisor = await attempt('versions.supervisor', () => supData('/supervisor/info'))
    if (isPlainObject(supervisor)) versions.supervisor = asString(supervisor.version, '') || null
    const os = await attempt('versions.os', () => supData('/os/info'))
    if (isPlainObject(os)) versions.os = asString(os.version, '') || null
    collected.versions = versions
    if (asString(config?.time_zone, '') !== '') collected.time_zone = config.time_zone
  }

  if (want('host')) {
    const host = await attempt('host', () => supData('/host/info'))
    if (isPlainObject(host)) {
      const gib = (bytes) => (Number.isFinite(Number(bytes)) ? Math.round((Number(bytes) / 1024 ** 3) * 10) / 10 : null)
      collected.host = {
        machine: asString(host.machine, null),
        arch: asString(host.arch, null),
        os: asString(host.operating_system, asString(host.os, null)),
        disk_free_gib: gib(host.disk_free),
        disk_total_gib: gib(host.disk_total),
        disk_free: Number.isFinite(Number(host.disk_free)) ? Number(host.disk_free) : null,
        disk_total: Number.isFinite(Number(host.disk_total)) ? Number(host.disk_total) : null,
        dt_synchronized: typeof host.dt_synchronized === 'boolean' ? host.dt_synchronized : null,
      }
    }
  }

  if (want('system')) {
    const info = await attempt('system', () => supData('/info'))
    if (isPlainObject(info)) {
      collected.system = {
        arch: asString(info.arch, null),
        supported_arch: Array.isArray(info.supported_arch) ? info.supported_arch : null,
        channel: asString(info.channel, null),
        healthy: typeof info.healthy === 'boolean' ? info.healthy : null,
        hostname: asString(info.hostname, null),
      }
    }
  }

  let states = null
  if (want('entities') || want('automations')) {
    states = await attempt('states', async () => {
      const payload = await haOk('/states')
      source.push('GET /core/api/states')
      return Array.isArray(payload) ? payload : []
    })
  }

  if (want('integrations')) {
    const components = Array.isArray(config?.components) ? config.components : []
    collected.integrations = { count: components.length }
  }

  if (want('entities') && Array.isArray(states)) {
    const unavailable = states.filter((state) => state?.state === 'unavailable' || state?.state === 'unknown')
    const byDomain = {}
    for (const state of states) {
      const domain = String(state?.entity_id ?? '').split('.')[0] || 'unknown'
      byDomain[domain] = (byDomain[domain] ?? 0) + 1
    }
    collected.entities = {
      total: states.length,
      unavailable: unavailable.length,
      by_domain: byDomain,
    }
  }

  if (want('automations') && Array.isArray(states)) {
    collected.automations = states
      .filter((state) => String(state?.entity_id ?? '').startsWith('automation.'))
      .slice(0, 100)
      .map((state) => ({
        entity_id: state.entity_id,
        alias: asString(state?.attributes?.friendly_name, null),
        state: asString(state?.state, null),
        last_triggered: typeof state?.attributes?.last_triggered === 'string' ? state.attributes.last_triggered : null,
      }))
  }

  if (want('apps')) {
    const addons = await attempt('apps', () => supData('/addons'))
    const list = Array.isArray(addons?.addons) ? addons.addons : Array.isArray(addons) ? addons : []
    collected.apps = list.slice(0, 100).map((addon) => ({
      slug: asString(addon?.slug, ''),
      name: asString(addon?.name, ''),
      version: asString(addon?.version, null),
      state: asString(addon?.state, null),
      boot: asString(addon?.boot, null),
      watchdog: typeof addon?.watchdog === 'boolean' ? addon.watchdog : null,
      update_available: addon?.update_available === true,
      option_keys: isPlainObject(addon?.options) ? Object.keys(addon.options).slice(0, 40) : [],
    }))
  }

  if (want('updates')) {
    const updates = await attempt('updates', () => supData('/available_updates'))
    const list = Array.isArray(updates?.available_updates) ? updates.available_updates : Array.isArray(updates) ? updates : []
    collected.updates = {
      count: list.length,
      updates: list.slice(0, 50).map((update) => ({
        name: asString(update?.name, asString(update?.entity_id, '')),
        version: asString(update?.version, asString(update?.latest_version, null)),
        current_version: asString(update?.current_version, asString(update?.installed_version, null)),
        type: asString(update?.update_type, null),
      })),
    }
  }

  if (want('backups')) {
    const backups = await attempt('backups', () => supData('/backups/info'))
    const list = Array.isArray(backups?.backups) ? backups.backups : []
    collected.backups = {
      count: Number.isFinite(Number(backups?.backups_count)) ? Number(backups.backups_count) : list.length,
      newest: asString(backups?.last_backup, newestBackupDate(list)) || null,
      days_until_stale: Number.isFinite(Number(backups?.days_until_stale)) ? Number(backups.days_until_stale) : null,
    }
  }

  collected.collected_at = nowIso()
  return { collected: boundCollected(collected), source, errors }
}

/** @param {unknown[]} list @returns {string} */
function newestBackupDate(list) {
  const dates = list
    .map((backup) => asString(backup?.date, asString(backup?.created_at, '')))
    .filter((date) => date !== '' && Number.isFinite(Date.parse(date)))
    .sort()
  return dates.at(-1) ?? ''
}

/** @returns {Promise<object>} the backup ledger */
export async function readBackups(limit = 200) {
  const raw = await readJson(memoryFiles().backups, null)
  const entries = Array.isArray(raw?.entries) ? raw.entries : []
  return {
    schema_version: SCHEMA_VERSION,
    updated_at: typeof raw?.updated_at === 'string' ? raw.updated_at : null,
    count: entries.length,
    entries: entries.slice(-Math.max(0, limit)),
  }
}

/** @param {object[]} entries */
async function appendBackups(entries) {
  const raw = await readJson(memoryFiles().backups, null)
  const list = Array.isArray(raw?.entries) ? raw.entries : []
  list.push(...entries)
  const bounded = list.slice(-BACKUPS_MAX_ENTRIES)
  await writeJsonAtomic(memoryFiles().backups, {
    schema_version: SCHEMA_VERSION,
    updated_at: nowIso(),
    entries: bounded,
  })
}

/**
 * Append one entry to the changelog and rotate when it exceeds 2 MB.
 * @param {object} entry
 * @returns {Promise<object>} the normalised entry
 */
export async function recordChange(entry = {}) {
  const normalized = normalizeChangeEntry(entry)
  await appendChangelogEntry(normalized)
  return normalized
}

/** @param {object} entry */
async function appendChangelogEntry(entry) {
  const files = memoryFiles()
  await appendJsonl(files.changelog, entry)
  await rotateChangelog()
}

/**
 * Read the last `limit` changelog lines (oldest first).
 * @param {number} [limit]
 * @returns {Promise<object[]>}
 */
export async function readChangelog(limit = 20) {
  const lines = await readJsonl(memoryFiles().changelog)
  return lines.slice(-Math.max(0, limit))
}

/**
 * Rotate `changelog.jsonl` when it exceeds the byte budget.
 * @param {{ max_bytes?: number, keep_lines?: number }} [options]
 * @returns {Promise<{ rotated: boolean, kept: number, removed: number, bytes_before: number }>}
 */
export async function rotateChangelog(options = {}) {
  const files = memoryFiles()
  const maxBytes = Number.isFinite(Number(options.max_bytes)) ? Number(options.max_bytes) : CHANGELOG_MAX_BYTES
  const keepLines = Number.isFinite(Number(options.keep_lines)) ? Math.max(1, Number(options.keep_lines)) : CHANGELOG_KEEP_LINES
  let bytes = 0
  try {
    bytes = (await stat(files.changelog)).size
  } catch {
    return { rotated: false, kept: 0, removed: 0, bytes_before: 0 }
  }
  if (bytes < maxBytes) return { rotated: false, kept: 0, removed: 0, bytes_before: bytes }
  const lines = await readJsonl(files.changelog)
  if (lines.length === 0) return { rotated: false, kept: 0, removed: 0, bytes_before: bytes }
  const kept = lines.slice(-keepLines)
  await writeTextAtomic(files.changelog, kept.map((line) => `${JSON.stringify(line)}\n`).join(''))
  return { rotated: true, kept: kept.length, removed: lines.length - kept.length, bytes_before: bytes }
}

/** Compact baseline file shared with monitoring. */
async function writeBaselinesFromCollected(collected) {
  const versions = summarizeVersions(collected)
  const host = isPlainObject(collected) && isPlainObject(collected.host) ? collected.host : {}
  const backups = isPlainObject(collected) && isPlainObject(collected.backups) ? collected.backups : {}
  const entities = isPlainObject(collected) && isPlainObject(collected.entities) ? collected.entities : {}
  await writeJsonAtomic(memoryFiles().baselines, {
    schema_version: SCHEMA_VERSION,
    updated_at: nowIso(),
    collected_at: isPlainObject(collected) ? asString(collected.collected_at, null) : null,
    versions,
    host: {
      machine: asString(host.machine, null),
      arch: asString(host.arch, null),
      disk_free: Number.isFinite(Number(host.disk_free)) ? Number(host.disk_free) : null,
      disk_total: Number.isFinite(Number(host.disk_total)) ? Number(host.disk_total) : null,
    },
    entities: {
      total: Number(entities.total ?? 0),
      unavailable: Number(entities.unavailable ?? 0),
    },
    backups: {
      count: Number(backups.count ?? 0),
      newest: asString(backups.newest, null),
      days_until_stale: Number.isFinite(Number(backups.days_until_stale)) ? Number(backups.days_until_stale) : null,
    },
  })
}

/** @returns {Promise<object>} compact baselines from memory/baselines.json */
export async function readBaselines() {
  const raw = await readJson(memoryFiles().baselines, null)
  return isPlainObject(raw) ? raw : { schema_version: SCHEMA_VERSION, updated_at: null }
}

/**
 * Render the human-readable `system.md`. Never contains tokens or secrets.
 * @param {object} memory
 * @returns {Promise<string>}
 */
export async function renderSystemMd(memory) {
  const curated = normalizeCurated(memory?.curated)
  const collected = isPlainObject(memory?.collected) ? memory.collected : {}
  const lines = []
  lines.push('# Home Assistant memory')
  lines.push('')
  lines.push(`_Revision ${memory?.revision ?? 0} · updated ${asString(memory?.updated_at, 'never')} · schema ${SCHEMA_VERSION}_`)
  lines.push('')
  lines.push('## What I know about your home')
  lines.push('')
  if (curated.preferences.length > 0) {
    lines.push('### Preferences')
    for (const text of curated.preferences) lines.push(`- ${sanitizeText(text)}`)
    lines.push('')
  }
  if (curated.hardware.length > 0) {
    lines.push('### Hardware and setup')
    for (const text of curated.hardware) lines.push(`- ${sanitizeText(text)}`)
    lines.push('')
  }
  if (curated.quirks.length > 0) {
    lines.push('### Quirks and known issues')
    for (const quirk of curated.quirks) {
      const state = quirk.resolved === null ? 'open' : `resolved ${String(quirk.resolved).slice(0, 10)}`
      lines.push(`- [${state}] ${sanitizeText(quirk.text)} (added ${String(quirk.added ?? '').slice(0, 10)})`)
    }
    lines.push('')
  }
  if (Object.keys(curated.intent).length > 0) {
    lines.push('### Intent behind automations')
    for (const [key, value] of Object.entries(curated.intent)) lines.push(`- \`${sanitizeText(key)}\`: ${sanitizeText(value)}`)
    lines.push('')
  }
  if (curated.do_not_touch.length > 0) {
    lines.push('### Do not touch')
    for (const text of curated.do_not_touch) lines.push(`- ${sanitizeText(text)}`)
    lines.push('')
  }
  if (curated.open_tasks.length > 0) {
    lines.push('### Open tasks')
    for (const text of curated.open_tasks) lines.push(`- ${sanitizeText(text)}`)
    lines.push('')
  }
  if (curated.incidents.length > 0) {
    lines.push('### Past incidents')
    for (const text of curated.incidents) lines.push(`- ${sanitizeText(text)}`)
    lines.push('')
  }
  if (Object.keys(curated.backup_policy).length > 0) {
    lines.push('### Backup policy')
    for (const [key, value] of Object.entries(curated.backup_policy)) lines.push(`- ${key}: ${String(value)}`)
    lines.push('')
  }

  lines.push('## Collected inventory (deterministic, no model)')
  lines.push('')
  const versions = summarizeVersions(collected)
  const versionText = ['HA', 'Supervisor', 'OS']
    .map((label, index) => [label, [versions.ha, versions.supervisor, versions.os][index]])
    .filter(([, version]) => version !== null)
    .map(([label, version]) => `${label} ${version}`)
  if (versionText.length > 0) lines.push(`- Versions: ${versionText.join(' · ')}`)
  if (isPlainObject(collected.host)) {
    const host = collected.host
    const disk = Number.isFinite(Number(host.disk_free_gib)) && Number.isFinite(Number(host.disk_total_gib))
      ? `, disk ${host.disk_free_gib}/${host.disk_total_gib} GiB free`
      : ''
    lines.push(`- Host: ${asString(host.machine, 'unknown')}/${asString(host.arch, 'unknown')}${disk}`)
  }
  if (isPlainObject(collected.integrations)) lines.push(`- Integrations: ${Number(collected.integrations.count ?? 0)}`)
  if (isPlainObject(collected.entities)) {
    lines.push(`- Entities: ${Number(collected.entities.total ?? 0)} (${Number(collected.entities.unavailable ?? 0)} unavailable)`)
  }
  if (Array.isArray(collected.automations)) lines.push(`- Automations: ${collected.automations.length} snapshotted`)
  if (Array.isArray(collected.apps)) {
    const updates = collected.apps.filter((app) => app?.update_available === true).length
    lines.push(`- Apps: ${collected.apps.length}${updates > 0 ? `, ${updates} update(s) available` : ''}`)
  }
  if (isPlainObject(collected.backups)) {
    const backups = collected.backups
    lines.push(`- Backups: ${Number(backups.count ?? 0)}, newest ${asString(backups.newest, 'unknown')}${Number.isFinite(Number(backups.days_until_stale)) ? `, ${Number(backups.days_until_stale)} days until stale` : ''}`)
  }
  lines.push(`- Collected at: ${asString(collected.collected_at, 'never')}`)
  lines.push('')

  const changelog = await readChangelog(10)
  if (changelog.length > 0) {
    lines.push('## Recent changes')
    lines.push('')
    for (const entry of changelog.reverse()) {
      const label = asString(entry.reason, asString(entry.kind, 'change'))
      lines.push(`- ${String(entry.ts ?? '').slice(0, 16)} — ${sanitizeText(label).slice(0, 160)}`)
    }
    lines.push('')
  }
  lines.push('_This file is safe to show to the user; it never contains tokens, passwords or secrets._')

  let markdown = `${lines.join('\n')}\n`
  if (Buffer.byteLength(markdown, 'utf8') > SYSTEM_MD_MAX_BYTES) {
    markdown = `${markdown.slice(0, SYSTEM_MD_MAX_BYTES)}\n…[truncated]\n`
  }
  return markdown
}
