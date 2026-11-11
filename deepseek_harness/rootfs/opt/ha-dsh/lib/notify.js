/**
 * Notification delivery for the monitoring subsystem.
 *
 * Channels:
 * - a Home Assistant persistent notification (`persistent_notification.create`);
 * - an optional notify service from the add-on option (`notify.<service>`).
 *
 * Safety rules:
 * - quiet hours suppress severity < 3 unless `force` is set;
 * - at most `max_per_hour` notifications are delivered per rolling hour;
 * - an optional `dedupe_key` suppresses repeats inside `throttle_ms`.
 *
 * The module never throws out of a delivery attempt: channel failures are
 * collected in `errors` so a probe can degrade to the digest.
 *
 * @module notify
 */

import { join } from 'node:path'

import { getOptions, getPaths } from './paths.js'
import { callService } from './ha-core.js'
import { ToolError, isPlainObject, nowIso, readJson, sha256, writeJsonAtomic } from './result.js'

/** Rolling window used for the hourly notification cap (1 h). */
export const HOUR_MS = 60 * 60 * 1000

/** Default per-dedupe-key throttle window. */
export const DEFAULT_THROTTLE_MS = 60 * 60 * 1000

/** Default maximum delivered notifications per rolling hour. */
export const DEFAULT_MAX_PER_HOUR = 3

/** The notify service pattern accepted by the add-on option. */
const NOTIFY_SERVICE = /^notify\.([a-z0-9_]+)$/i

/** @returns {string} absolute path of the notification throttle state */
function throttleFile() {
  return join(getPaths().monitor, 'notify-state.json')
}

/**
 * Parse a quiet-hours spec such as `22:00-07:00`.
 * @param {unknown} spec
 * @returns {{ start: number, end: number }|null} minutes since midnight, or null when disabled/invalid
 */
export function parseQuietHours(spec) {
  if (typeof spec !== 'string' || spec.trim() === '') return null
  const match = spec.trim().match(/^([01]?\d|2[0-3]):([0-5]\d)-([01]?\d|2[0-3]):([0-5]\d)$/)
  if (match === null) return null
  const start = Number(match[1]) * 60 + Number(match[2])
  const end = Number(match[3]) * 60 + Number(match[4])
  return { start, end }
}

/**
 * Whether `date` falls inside the quiet window. Windows may wrap midnight.
 * @param {unknown} spec quiet-hours string
 * @param {Date} [date]
 * @returns {boolean}
 */
export function inQuietHours(spec, date = new Date()) {
  const window = parseQuietHours(spec)
  if (window === null) return false
  const minutes = date.getHours() * 60 + date.getMinutes()
  if (window.start <= window.end) return minutes >= window.start && minutes < window.end
  return minutes >= window.start || minutes < window.end
}

/** @returns {Promise<{version: number, updated_at: string|null, keys: Record<string, object>, ring: number[]}>} */
export async function readNotifyState() {
  const raw = await readJson(throttleFile(), null)
  const keys = isPlainObject(raw?.keys) ? raw.keys : {}
  const ring = Array.isArray(raw?.ring) ? raw.ring.filter((value) => Number.isFinite(value)) : []
  return {
    version: 1,
    updated_at: typeof raw?.updated_at === 'string' ? raw.updated_at : null,
    keys,
    ring,
  }
}

/** @param {object} state */
export async function writeNotifyState(state) {
  const bounded = {
    version: 1,
    updated_at: nowIso(),
    keys: state.keys ?? {},
    ring: (state.ring ?? []).slice(-200),
  }
  await writeJsonAtomic(throttleFile(), bounded)
  return bounded
}

/** Prune stale throttle keys so the state file stays bounded. */
function pruneState(state, now, throttleMs) {
  const cutoff = now - Math.max(throttleMs, HOUR_MS) * 2
  for (const [key, entry] of Object.entries(state.keys)) {
    const last = Number(entry?.last_at_ms)
    if (!Number.isFinite(last) || last < cutoff) delete state.keys[key]
  }
  const keys = Object.keys(state.keys)
  if (keys.length > 500) {
    const keep = keys
      .map((key) => ({ key, last: Number(state.keys[key]?.last_at_ms ?? 0) }))
      .sort((a, b) => b.last - a.last)
      .slice(0, 500)
    const kept = {}
    for (const item of keep) kept[item.key] = state.keys[item.key]
    state.keys = kept
  }
  state.ring = state.ring.filter((value) => value > now - HOUR_MS).slice(-100)
  return state
}

/**
 * Deliver one user-facing notification.
 *
 * Never throws for delivery failures; invalid arguments throw `ToolError`.
 *
 * @param {{
 *   title?: string,
 *   message: string,
 *   severity?: number,
 *   dedupe_key?: string,
 *   notification_id?: string,
 *   quiet_hours?: string,
 *   notify_service?: string,
 *   throttle_ms?: number,
 *   max_per_hour?: number,
 *   force?: boolean,
 *   data?: Record<string, unknown>,
 * }} options
 * @returns {Promise<{
 *   delivered: string[], suppressed: string[], quiet_hours: boolean,
 *   severity: number, title: string, at: string, errors: object[],
 *   throttled: boolean, dedupe_key: string|null,
 * }>}
 */
export async function notifyUser(options = {}) {
  const title = typeof options.title === 'string' && options.title.trim() !== '' ? options.title.trim().slice(0, 120) : 'DeepSeek Harness'
  const message = typeof options.message === 'string' ? options.message.trim() : ''
  if (message === '') throw new ToolError('INVALID_ARGUMENT', 'A notification message is required.')
  const rawSeverity = Number(options.severity ?? 2)
  const severity = Number.isFinite(rawSeverity) ? Math.max(0, Math.min(4, Math.trunc(rawSeverity))) : 2
  const dedupeKey = typeof options.dedupe_key === 'string' && options.dedupe_key.trim() !== '' ? options.dedupe_key.trim().slice(0, 200) : null
  const force = options.force === true
  const throttleMs = Number.isFinite(Number(options.throttle_ms))
    ? Math.max(60_000, Number(options.throttle_ms))
    : DEFAULT_THROTTLE_MS
  const maxPerHour = Number.isFinite(Number(options.max_per_hour))
    ? Math.max(0, Math.min(20, Math.trunc(Number(options.max_per_hour))))
    : DEFAULT_MAX_PER_HOUR
  const configuredQuietHours = options.quiet_hours ?? getOptions().quietHours
  const quiet = inQuietHours(configuredQuietHours)
  const at = nowIso()
  const now = Date.now()

  /** @type {string[]} */
  const delivered = []
  /** @type {string[]} */
  const suppressed = []
  /** @type {{ channel: string, message: string }[]} */
  const errors = []

  if (!force && quiet && severity < 3) {
    return {
      delivered,
      suppressed: ['quiet_hours'],
      quiet_hours: true,
      severity,
      title,
      at,
      errors,
      throttled: false,
      dedupe_key: dedupeKey,
    }
  }

  const state = pruneState(await readNotifyState(), now, throttleMs)
  if (!force && maxPerHour > 0 && state.ring.filter((value) => value > now - HOUR_MS).length >= maxPerHour) {
    return {
      delivered,
      suppressed: ['rate_limit'],
      quiet_hours: quiet,
      severity,
      title,
      at,
      errors,
      throttled: true,
      dedupe_key: dedupeKey,
    }
  }
  if (!force && dedupeKey !== null) {
    const entry = state.keys[dedupeKey]
    const last = Number(entry?.last_at_ms)
    if (Number.isFinite(last) && now - last < throttleMs) {
      return {
        delivered,
        suppressed: ['dedupe'],
        quiet_hours: quiet,
        severity,
        title,
        at,
        errors,
        throttled: true,
        dedupe_key: dedupeKey,
      }
    }
  }

  const notificationId =
    typeof options.notification_id === 'string' && options.notification_id.trim() !== ''
      ? options.notification_id.trim().slice(0, 64)
      : dedupeKey === null
        ? undefined
        : `dsh_${sha256(dedupeKey).slice(0, 16)}`

  try {
    await callService('persistent_notification', 'create', {
      title,
      message,
      ...(notificationId === undefined ? {} : { notification_id: notificationId }),
    })
    delivered.push('persistent_notification')
  } catch (error) {
    errors.push({ channel: 'persistent_notification', message: errorMessage(error) })
  }

  const notifyService = typeof options.notify_service === 'string' && options.notify_service.trim() !== ''
    ? options.notify_service.trim()
    : getOptions().notifyService
  if (typeof notifyService === 'string' && notifyService.trim() !== '') {
    const match = notifyService.trim().match(NOTIFY_SERVICE)
    if (match === null) {
      errors.push({
        channel: 'notify_service',
        message: `Unsupported notify service "${notifyService}": expected notify.<service>.`,
      })
    } else {
      const service = match[1]
      try {
        await callService('notify', service, {
          title,
          message,
          ...(isPlainObject(options.data) ? { data: options.data } : {}),
        })
        delivered.push(`notify.${service}`)
      } catch (error) {
        errors.push({ channel: `notify.${service}`, message: errorMessage(error) })
      }
    }
  }

  if (delivered.length > 0) {
    state.keys[dedupeKey ?? `anon:${sha256(`${title}\u0000${message}`).slice(0, 16)}`] = {
      last_at_ms: now,
      last_at: at,
      severity,
      delivered,
    }
    state.ring.push(now)
    try {
      await writeNotifyState(state)
    } catch (error) {
      errors.push({ channel: 'throttle_state', message: errorMessage(error) })
    }
  }

  return {
    delivered,
    suppressed,
    quiet_hours: quiet,
    severity,
    title,
    at,
    errors,
    throttled: false,
    dedupe_key: dedupeKey,
  }
}

/** @param {unknown} error @returns {string} */
function errorMessage(error) {
  return error instanceof Error ? error.message : String(error)
}
