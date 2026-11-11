#!/usr/bin/env node
/**
 * Monitor a Home Assistant add-on update/install through the Supervisor API.
 *
 * The Supervisor panel shows a spinner while the app image is built on the
 * device; this script makes the same progress visible in a terminal and is what
 * the project uses for its own update tests.
 *
 * Usage:
 *   HA_URL=http://homeassistant.local:8123 \
 *   HA_TOKEN=<long-lived access token> \
 *   node scripts/monitor-addon.mjs [slug] [expected-version]
 *
 * `slug` defaults to `f66e0319_deepseek_harness` (repository-id + slug) only as
 * an example; pass yours explicitly. Exits when the expected version is started,
 * when the app disappears (uninstall), or after the timeout.
 */

const HA_URL = (process.env.HA_URL ?? 'http://homeassistant.local:8123').replace(/\/+$/, '')
const TOKEN = process.env.HA_TOKEN
const SLUG = process.argv[2] ?? 'f66e0319_deepseek_harness'
const EXPECTED = process.argv[3]
const TIMEOUT_MS = Number.parseInt(process.env.MONITOR_TIMEOUT_MS ?? '900000', 10)

if (TOKEN === undefined || TOKEN === '') {
  console.error('HA_TOKEN is required (long-lived access token from your HA profile)')
  process.exit(2)
}

const ws = new WebSocket(HA_URL.replace(/^http/, 'ws') + '/api/websocket')
let nextId = 1
const pending = new Map()

/** @param {string} type @param {Record<string, unknown>} payload */
function call(type, payload = {}, timeoutMs = 60_000) {
  const message = { id: nextId++, type, ...payload }
  ws.send(JSON.stringify(message))
  return Promise.race([
    new Promise((resolve) => pending.set(message.id, resolve)),
    new Promise((resolve) => setTimeout(() => resolve({ timeout: true }), timeoutMs)),
  ])
}

const ready = new Promise((resolve, reject) => {
  ws.addEventListener('message', (event) => {
    const message = JSON.parse(event.data)
    if (message.type === 'auth_required') ws.send(JSON.stringify({ type: 'auth', access_token: TOKEN }))
    else if (message.type === 'auth_ok') resolve(undefined)
    else if (message.type === 'auth_invalid') reject(new Error('authentication failed'))
    else if (message.id !== undefined && pending.has(message.id)) {
      pending.get(message.id)(message)
      pending.delete(message.id)
    }
  })
  ws.addEventListener('error', () => reject(new Error(`cannot connect to ${HA_URL}`)))
  setTimeout(() => reject(new Error('websocket authentication timeout')), 15_000)
})

/** @param {string} endpoint */
async function supervisor(endpoint) {
  const reply = await call('supervisor/api', { endpoint, method: 'get' }, 30_000)
  if (reply.timeout || reply.success === false) return undefined
  return reply.result
}

const startedAt = Date.now()
let lastLine = ''

await ready
console.log(`monitoring ${SLUG} (expected ${EXPECTED ?? 'any version'}), timeout ${TIMEOUT_MS / 1000}s`)

for (;;) {
  if (Date.now() - startedAt > TIMEOUT_MS) {
    console.error('timeout: the update did not finish')
    process.exit(1)
  }
  const info = await supervisor(`/addons/${SLUG}/info`)
  const elapsed = ((Date.now() - startedAt) / 1000).toFixed(0).padStart(4)
  if (info === undefined) {
    if (lastLine !== 'unavailable') console.log(`${elapsed}s  add-on info unavailable (Supervisor busy or app removed)`)
    lastLine = 'unavailable'
  } else {
    const line = `${info.state ?? 'unknown'} v${info.version ?? '?'}${info.update_available ? ' (update available)' : ''}`
    if (line !== lastLine) {
      console.log(`${elapsed}s  ${line}`)
      lastLine = line
    }
    if (EXPECTED !== undefined && info.state === 'started' && info.version === EXPECTED) {
      console.log(`done: ${SLUG} ${EXPECTED} is started`)
      ws.close()
      process.exit(0)
    }
    if (info.installed === false) {
      console.log('the app is not installed (uninstalled or detached)')
      ws.close()
      process.exit(1)
    }
  }
  await new Promise((resolve) => setTimeout(resolve, 5_000))
}
