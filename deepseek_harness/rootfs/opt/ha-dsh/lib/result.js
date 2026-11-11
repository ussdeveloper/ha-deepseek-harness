/**
 * Result envelope, error taxonomy and small filesystem/JSON helpers shared by
 * the plugin tools, the collector and the ingress shim.
 *
 * Every model-facing tool returns one canonical JSON value: `ok` / `fail`.
 * Tools never throw raw errors out: `toErrorResult` normalises anything caught.
 *
 * @module result
 */

import { createHash, randomBytes } from 'node:crypto'
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'

/** Closed error-code set used by every tool. */
export const ERROR_CODES = Object.freeze([
  'NOT_FOUND',
  'FORBIDDEN',
  'UNSUPPORTED',
  'UPSTREAM_ERROR',
  'NEEDS_APPROVAL',
  'CONFLICT',
  'INVALID_ARGUMENT',
  'INTERNAL',
])

/** A tool-visible failure with a stable code and an optional next safe action. */
export class ToolError extends Error {
  /**
   * @param {string} code one of {@link ERROR_CODES}
   * @param {string} message human-readable explanation
   * @param {{ hint?: string, retryable?: boolean, data?: unknown }} [details]
   */
  constructor(code, message, details = {}) {
    super(message)
    this.name = 'ToolError'
    this.code = code
    this.hint = details.hint
    this.retryable = details.retryable ?? false
    this.data = details.data
  }
}

/** Current time as an ISO-8601 string with the local offset. */
export function nowIso() {
  return new Date().toISOString()
}

/** @param {unknown} value @returns {string} lowercase SHA-256 hex digest */
export function sha256(value) {
  return createHash('sha256').update(String(value), 'utf8').digest('hex')
}

/** Random URL-safe token (used for dry-run confirmations). */
export function randomToken(bytes = 18) {
  return randomBytes(bytes).toString('base64url')
}

/** Whether `value` is a plain object (not an array, null or class instance). */
export function isPlainObject(value) {
  return typeof value === 'object' && value !== null && Object.getPrototypeOf(value) === Object.prototype
}

/**
 * Deterministic JSON for hashing arguments: keys sorted recursively, arrays in
 * order, `undefined` omitted. Two structurally equal calls hash identically.
 * @param {unknown} value
 * @returns {string}
 */
export function stableStringify(value) {
  if (value === undefined) return 'undefined'
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`
  if (!isPlainObject(value)) return '"[unsupported]"'
  const keys = Object.keys(value).filter((key) => value[key] !== undefined).sort()
  return `{${keys.map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(',')}}`
}

/**
 * Build a successful tool result.
 * @param {string} summary one line for the model/UI card
 * @param {unknown} data canonical output
 * @param {{ source?: string[], redacted?: boolean, truncated?: boolean, warnings?: object[] }} [meta]
 * @returns {object}
 */
export function ok(summary, data, meta = {}) {
  return {
    ok: true,
    summary,
    data,
    warnings: meta.warnings ?? [],
    meta: {
      source: meta.source ?? [],
      fetched_at: nowIso(),
      redacted: meta.redacted ?? false,
      truncated: meta.truncated ?? false,
    },
  }
}

/**
 * Build a failed tool result.
 * @param {string} code {@link ERROR_CODES} member
 * @param {string} message human-readable explanation
 * @param {{ hint?: string, retryable?: boolean, data?: unknown, source?: string[] }} [details]
 * @returns {object}
 */
export function fail(code, message, details = {}) {
  return {
    ok: false,
    error: {
      code: ERROR_CODES.includes(code) ? code : 'INTERNAL',
      message,
      ...(details.hint === undefined ? {} : { hint: details.hint }),
      retryable: details.retryable ?? false,
    },
    ...(details.data === undefined ? {} : { data: details.data }),
    meta: {
      source: details.source ?? [],
      fetched_at: nowIso(),
      redacted: false,
      truncated: false,
    },
  }
}

/** Normalise a caught error (including {@link ToolError}) into a failed result. */
export function toErrorResult(error, source = []) {
  if (error instanceof ToolError) {
    return fail(error.code, error.message, {
      hint: error.hint,
      retryable: error.retryable,
      data: error.data,
      source,
    })
  }
  const message = error instanceof Error ? error.message : String(error)
  return fail('INTERNAL', message, {
    hint: 'Unexpected plugin failure; check the add-on log and retry.',
    source,
  })
}

/** Render a canonical value as the model-facing content blocks. */
export function renderJson(_args, value) {
  return [{ type: 'text', text: JSON.stringify(value) }]
}

/** Truncate a string to `max` characters with a visible marker. */
export function truncate(text, max = 4000) {
  const value = String(text ?? '')
  if (value.length <= max) return { text: value, truncated: false }
  return { text: `${value.slice(0, max)}\n…[truncated ${value.length - max} chars]`, truncated: true }
}

const SECRET_KEY = /(token|password|passwd|secret|apikey|api_key|authorization|credential|cookie)/i

/**
 * Recursively mask secret-looking keys. Values under an allow-listed key stay.
 * @param {unknown} value
 * @param {Set<string>} [allow]
 * @returns {unknown}
 */
export function redact(value, allow = new Set()) {
  if (Array.isArray(value)) return value.map((item) => redact(item, allow))
  if (!isPlainObject(value)) return value
  /** @type {Record<string, unknown>} */
  const out = {}
  for (const [key, item] of Object.entries(value)) {
    if (SECRET_KEY.test(key) && !allow.has(key)) {
      out[key] = item === null || item === undefined || item === '' ? item : '[redacted]'
      continue
    }
    out[key] = redact(item, allow)
  }
  return out
}

/** Read and parse a JSON file, returning `fallback` when absent or unreadable. */
export async function readJson(file, fallback = undefined) {
  try {
    return JSON.parse(await readFile(file, 'utf8'))
  } catch {
    return fallback
  }
}

/** Create parent directories and write JSON atomically (temp file + rename). */
export async function writeJsonAtomic(file, value, mode = 0o600) {
  await mkdir(dirname(file), { recursive: true })
  const temp = `${file}.${randomBytes(4).toString('hex')}.tmp`
  try {
    await writeFile(temp, `${JSON.stringify(value, null, 2)}\n`, { encoding: 'utf8', mode, flag: 'wx' })
    await rename(temp, file)
  } catch (error) {
    await rm(temp, { force: true })
    throw error
  }
}

/** Write a text file atomically (temp file + rename). */
export async function writeTextAtomic(file, content, mode = 0o600) {
  await mkdir(dirname(file), { recursive: true })
  const temp = `${file}.${randomBytes(4).toString('hex')}.tmp`
  try {
    await writeFile(temp, content, { encoding: 'utf8', mode, flag: 'wx' })
    await rename(temp, file)
  } catch (error) {
    await rm(temp, { force: true })
    throw error
  }
}

/** Append one JSON line to a JSONL file, creating it if needed. */
export async function appendJsonl(file, entry) {
  await mkdir(dirname(file), { recursive: true })
  const line = `${JSON.stringify(entry)}\n`
  const { appendFile } = await import('node:fs/promises')
  await appendFile(file, line, 'utf8')
}

/** Parse a JSONL file into an array, skipping malformed lines. */
export async function readJsonl(file) {
  try {
    const text = await readFile(file, 'utf8')
    return text
      .split('\n')
      .filter((line) => line.trim() !== '')
      .map((line) => {
        try {
          return JSON.parse(line)
        } catch {
          return null
        }
      })
      .filter((item) => item !== null)
  } catch {
    return []
  }
}
