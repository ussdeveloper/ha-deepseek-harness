/**
 * Deterministic background collector.
 *
 * Zero LLM calls: it keeps the structured memory inventory fresh, runs the
 * read-only health probe, refreshes the local Home Assistant knowledge cache and
 * sends the daily digest. The agent's chat tools are independent of this loop;
 * if the collector fails the add-on keeps working.
 *
 * @module collector
 */

import { getOptions } from '../lib/paths.js'
import { refreshCollected, readMemory } from '../lib/memory-store.js'
import { probe, digest, readMonitorState } from '../lib/monitor-store.js'
import { scan } from '../lib/knowledge-store.js'

const options = getOptions()
const MEMORY_INTERVAL_MS = 30 * 60_000
const NEWS_INTERVAL_MS = 6 * 60 * 60_000
const MINUTE = 60_000

let stopping = false

/** @param {string} message */
function log(message) {
  process.stdout.write(`${new Date().toISOString()} [collector] ${message}\n`)
}

/** Sleep with abort support. @param {number} ms */
async function sleep(ms) {
  const deadline = Date.now() + ms
  while (!stopping && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, Math.min(5_000, deadline - Date.now())))
  }
}

/** @param {Promise<unknown>} work @param {string} label */
async function guarded(work, label) {
  try {
    return await work
  } catch (error) {
    log(`${label} failed: ${error instanceof Error ? error.message : String(error)}`)
    return undefined
  }
}

/** Parse `HH:MM` into minutes since midnight; null when malformed. */
function parseClock(spec) {
  const match = /^([01]?\d|2[0-3]):([0-5]\d)$/.exec(String(spec ?? '').trim())
  if (match === null) return null
  return Number(match[1]) * 60 + Number(match[2])
}

/** Whether the daily digest is due now for the configured local time. */
async function digestDue() {
  const target = parseClock(options.digestTime)
  if (target === null) return false
  const now = new Date()
  const minutes = now.getHours() * 60 + now.getMinutes()
  if (minutes < target) return false
  const state = await readMonitorState()
  const last = typeof state.last_digest === 'string' ? new Date(state.last_digest) : null
  return last === null || last.toDateString() !== now.toDateString()
}

/** One collection pass; returns the next sleep duration in milliseconds. */
async function runPass(state) {
  const now = Date.now()
  let next = options.monitorIntervalMin * MINUTE

  if (options.monitorEnabled && now - state.lastProbe >= options.monitorIntervalMin * MINUTE) {
    const findings = await guarded(() => probe({ deep: false, notify: true }), 'monitor probe')
    state.lastProbe = now
    if (findings !== undefined) {
      const count = Array.isArray(findings.findings) ? findings.findings.length : 0
      if (count > 0) log(`monitor probe: ${count} finding(s)`)
    }
  }

  if (now - state.lastMemory >= MEMORY_INTERVAL_MS) {
    const outcome = await guarded(() => refreshCollected(), 'memory refresh')
    state.lastMemory = now
    if (outcome !== undefined && outcome.changed === true) log('memory inventory updated')
  }

  if (options.monitorEnabled && now - state.lastNews >= NEWS_INTERVAL_MS) {
    const outcome = await guarded(() => scan({}), 'knowledge scan')
    state.lastNews = now
    if (outcome !== undefined) {
      const count = Array.isArray(outcome.new_items) ? outcome.new_items.length : 0
      if (count > 0) log(`knowledge scan: ${count} new item(s)`)
    }
  }

  if (options.monitorEnabled && (await guarded(() => digestDue(), 'digest check')) === true) {
    const outcome = await guarded(() => digest({ send: true, window_h: 24 }), 'daily digest')
    state.lastDigestAttempt = now
    if (outcome !== undefined) log('daily digest processed')
  }

  // Align the next pass to the probe cadence, never less than one minute.
  next = Math.max(MINUTE, Math.min(next, options.monitorIntervalMin * MINUTE))
  return next
}

/** Initial memory refresh right after boot, retrying while Supervisor warms up. */
async function initialRefresh() {
  for (let attempt = 1; attempt <= 6 && !stopping; attempt += 1) {
    const memory = await guarded(() => readMemory({ max_age_hours: 24 }), 'memory read')
    if (memory !== undefined) {
      await guarded(() => refreshCollected(), 'initial memory refresh')
      return
    }
    log(`waiting for Supervisor (attempt ${attempt}/6)`)
    await sleep(10_000)
  }
}

/** Main loop. */
async function main() {
  log(
    `started (monitor=${options.monitorEnabled}, probe_every=${options.monitorIntervalMin}m, digest=${options.digestTime})`,
  )
  await initialRefresh()

  const state = { lastProbe: 0, lastMemory: 0, lastNews: 0, lastDigestAttempt: 0 }
  while (!stopping) {
    const delay = await guarded(() => runPass(state), 'collection pass')
    await sleep(typeof delay === 'number' ? delay : MINUTE)
  }
}

process.on('SIGTERM', () => {
  stopping = true
  log('stopping (SIGTERM)')
  process.exit(0)
})
process.on('SIGINT', () => {
  stopping = true
  process.exit(0)
})

await main()
