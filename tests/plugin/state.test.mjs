/**
 * Unit tests for the stateful half of the HA plugin:
 * memory, monitoring, knowledge/news, notifications and the local app builder.
 *
 * Everything runs offline: `globalThis.fetch` is replaced by a router that
 * returns canned Supervisor/HA payloads. Writes stay inside temp directories
 * selected through DSH_DATA_DIR / DSH_HA_ADDONS_DIR.
 *
 * Run from the workspace root: node tests/plugin/state.test.mjs
 * (`node --test` cannot spawn its per-file child process in this sandbox.)
 */

import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { after, afterEach, beforeEach, describe, it } from 'node:test'

import { classify } from '../../deepseek_harness/rootfs/opt/ha-dsh/lib/safety.js'
import * as memoryStore from '../../deepseek_harness/rootfs/opt/ha-dsh/lib/memory-store.js'
import * as monitorStore from '../../deepseek_harness/rootfs/opt/ha-dsh/lib/monitor-store.js'
import * as knowledgeStore from '../../deepseek_harness/rootfs/opt/ha-dsh/lib/knowledge-store.js'
import * as notify from '../../deepseek_harness/rootfs/opt/ha-dsh/lib/notify.js'
import * as builder from '../../deepseek_harness/rootfs/opt/ha-dsh/lib/addon-builder.js'
import memoryTools, { tools as memoryToolsNamed } from '../../deepseek_harness/rootfs/opt/ha-dsh/plugin/tools/memory.js'
import monitorTools from '../../deepseek_harness/rootfs/opt/ha-dsh/plugin/tools/monitor.js'
import knowledgeTools from '../../deepseek_harness/rootfs/opt/ha-dsh/plugin/tools/knowledge.js'
import builderTools from '../../deepseek_harness/rootfs/opt/ha-dsh/plugin/tools/builder.js'
import notifyTools from '../../deepseek_harness/rootfs/opt/ha-dsh/plugin/tools/notify.js'

// ---------------------------------------------------------------------------
// Fake HTTP layer
// ---------------------------------------------------------------------------

/** @param {unknown} data @param {{status?: number, headers?: Record<string,string>}} [options] */
function jsonResponse(data, options = {}) {
  const status = options.status ?? 200
  const body = typeof data === 'string' ? data : JSON.stringify(data)
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: new Headers(options.headers ?? {}),
    async text() {
      return body
    },
    async json() {
      return JSON.parse(body)
    },
  }
}

/** Supervisor `{result:'ok', data}` envelope. */
function supOk(data, status = 200) {
  return jsonResponse({ result: 'ok', data }, { status })
}

class FetchRouter {
  constructor() {
    /** @type {Array<{url: string, method: string, headers: Record<string,string>, body: unknown}>} */
    this.calls = []
    /** @type {Array<{test: Function, handler: Function, method: string}>} */
    this.routes = []
  }

  /**
   * @param {string|Function} matcher URL fragment or predicate
   * @param {(call: object, router: FetchRouter) => object} handler
   * @param {string} [method] HTTP method or '*'
   */
  on(matcher, handler, method = 'GET') {
    const test = typeof matcher === 'function' ? matcher : (url) => String(url).includes(matcher)
    this.routes.push({ test, handler, method })
    return this
  }

  clearRoutes() {
    this.routes = []
    return this
  }

  reset() {
    this.calls = []
    this.routes = []
    return this
  }

  /** @param {string} fragment @param {string} [method] */
  count(fragment, method) {
    return this.calls.filter((call) => call.url.includes(fragment) && (method === undefined || call.method === method)).length
  }

  /** @param {string} fragment */
  lastCall(fragment) {
    return this.calls.filter((call) => call.url.includes(fragment)).at(-1)
  }

  async fetch(input, init = {}) {
    const url = String(input)
    const method = String(init.method ?? 'GET').toUpperCase()
    const headers = {}
    for (const [key, value] of Object.entries(init.headers ?? {})) headers[String(key).toLowerCase()] = String(value)
    const call = { url, method, headers, body: init.body }
    this.calls.push(call)
    const route = this.routes.find((candidate) => candidate.test(url, method) && (candidate.method === '*' || candidate.method === method))
    if (route === undefined) {
      return jsonResponse({ result: 'error', message: `no fake route for ${method} ${url}` }, { status: 404 })
    }
    return route.handler(call, this)
  }
}

// ---------------------------------------------------------------------------
// Fixtures and helpers
// ---------------------------------------------------------------------------

let root
let dataDir
let addonsDir
let router
let originalFetch

// The DSH sandbox does not allow writes to the OS temp directory, so scratch
// state lives in the workspace (and is removed after every test).
const TEST_TMP_ROOT = join(process.cwd(), 'tests', 'plugin', '.tmp-state')

/** @param {string} fixture */
function fixturePath(fixture) {
  return join(root, fixture)
}

/** Dynamic quiet window that contains the current local time. */
function currentQuietWindow() {
  const now = new Date()
  const pad = (value) => String(value).padStart(2, '0')
  const start = `${pad(now.getHours())}:00`
  const end = `${pad((now.getHours() + 1) % 24)}:00`
  return `${start}-${end}`
}

/** @param {string} name */
function findTool(name) {
  const modules = [memoryTools, monitorTools, knowledgeTools, builderTools, notifyTools]
  for (const module of modules) {
    const found = module.find((definition) => definition.name === name)
    if (found !== undefined) return found
  }
  throw new Error(`tool ${name} not found`)
}

/** 40 entities, `unavailable` of them unavailable, plus one healthy automation. */
function defaultStates({ unavailable = 6, total = 40, lastTriggered = new Date().toISOString() } = {}) {
  const states = []
  for (let index = 0; index < total; index++) {
    states.push({
      entity_id: `sensor.test_${index}`,
      state: index < unavailable ? 'unavailable' : 'ok',
      attributes: {},
      last_updated: new Date().toISOString(),
    })
  }
  states.push({
    entity_id: 'automation.porch',
    state: 'on',
    attributes: { friendly_name: 'Porch lights', last_triggered: lastTriggered },
    last_updated: new Date().toISOString(),
  })
  return states
}

/** Routes needed by every monitor probe. */
function seedMonitorScene(overrides = {}) {
  const states = overrides.states ?? defaultStates()
  const backupDate = overrides.backupDate ?? new Date().toISOString()
  router.on((url) => url.endsWith('/core/api/'), () => jsonResponse('API running.'))
  router.on((url) => url.includes('/core/api/states'), () => jsonResponse(states))
  if (overrides.errorLog !== undefined) {
    router.on((url) => url.includes('/core/api/error_log'), () => jsonResponse(overrides.errorLog))
  }
  router.on((url) => url.includes('/backups/info'), () => supOk({ backups: [{ date: backupDate }], days_until_stale: 25 }))
  router.on((url) => url.includes('/available_updates'), () => supOk({ available_updates: [] }))
  router.on((url) => url.endsWith('/addons'), () => supOk({ addons: [] }))
  router.on((url) => url.includes('/host/info'), () => supOk({ disk_free: 40 * 1024 ** 3, disk_total: 100 * 1024 ** 3 }))
  router.on((url) => url.includes('/resolution/info'), () => supOk({ healthy: true, unhealthy: [], unsupported: [], issues: [] }))
}

/** Routes needed by memory refresh (deterministic collection). */
function seedCollectScene() {
  // Fixed values so a second collection is byte-identical (refresh is idempotent).
  const states = defaultStates({ unavailable: 2, lastTriggered: '2026-11-10T17:12:00.000Z' })
  const backupDate = '2026-11-10T03:00:00.000Z'
  router.on((url) => url.includes('/core/api/config'), () => jsonResponse({
    version: '2026.11.1',
    time_zone: 'Europe/Warsaw',
    components: ['light', 'sensor', 'automation'],
  }))
  router.on((url) => url.includes('/core/api/states'), () => jsonResponse(states))
  router.on((url) => url.includes('/core/info'), () => supOk({ version: '2026.11.1' }))
  router.on((url) => url.includes('/supervisor/info'), () => supOk({ version: '2026.11.0' }))
  router.on((url) => url.includes('/os/info'), () => supOk({ version: '18.3' }))
  router.on((url) => url.includes('/host/info'), () => supOk({
    machine: 'generic-x86-64',
    arch: 'amd64',
    operating_system: 'Home Assistant OS 18.3',
    disk_free: 40 * 1024 ** 3,
    disk_total: 120 * 1024 ** 3,
    dt_synchronized: true,
  }))
  router.on((url) => url.endsWith('/info'), () => supOk({ arch: 'amd64', supported_arch: ['amd64'], channel: 'stable', healthy: true }))
  router.on((url) => url.endsWith('/addons'), () => supOk({ addons: [{ slug: 'core_mosquitto' }] }))
  router.on((url) => url.includes('/available_updates'), () => supOk({ available_updates: [] }))
  router.on((url) => url.includes('/backups/info'), () => supOk({ backups: [{ date: backupDate }], days_until_stale: 30 }))
}

const ATOM_FEED = `<?xml version="1.0" encoding="utf-8"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <entry>
    <title>2026.11.1: Matter improvements</title>
    <link rel="alternate" href="https://www.home-assistant.io/blog/2026/11/05/release-202611/"/>
    <published>${new Date(Date.now() - 86_400_000).toISOString()}</published>
    <summary><![CDATA[New Matter support and fixes for the recorder database.]]></summary>
  </entry>
  <entry>
    <title>2026.11.0: Backward-incompatible changes</title>
    <link rel="alternate" href="https://www.home-assistant.io/blog/2026/10/29/release-202610/"/>
    <published>${new Date(Date.now() - 7 * 86_400_000).toISOString()}</published>
    <summary><![CDATA[Deprecations in the template integration.]]></summary>
  </entry>
</feed>`

// ---------------------------------------------------------------------------
// Test lifecycle
// ---------------------------------------------------------------------------

beforeEach(async () => {
  await mkdir(TEST_TMP_ROOT, { recursive: true })
  root = await mkdtemp(join(TEST_TMP_ROOT, 'run-'))
  dataDir = join(root, 'data')
  addonsDir = join(root, 'addons')
  await mkdir(dataDir, { recursive: true })
  await mkdir(addonsDir, { recursive: true })
  process.env.DSH_DATA_DIR = dataDir
  process.env.DSH_HA_ADDONS_DIR = addonsDir
  process.env.DSH_SUPERVISOR_URL = 'http://supervisor'
  process.env.SUPERVISOR_TOKEN = 'test-token-not-real'
  process.env.DSH_OPT_NOTIFY_SERVICE = ''
  process.env.DSH_OPT_QUIET_HOURS = ''
  process.env.DSH_OPT_READ_ONLY = 'false'
  delete process.env.DSH_OPT_ALLOW_ADDON_MANAGEMENT
  router = new FetchRouter()
  originalFetch = globalThis.fetch
  globalThis.fetch = (input, init) => router.fetch(input, init)
})

afterEach(async () => {
  globalThis.fetch = originalFetch
  delete process.env.DSH_OPT_ALLOW_ADDON_MANAGEMENT
  process.env.DSH_OPT_QUIET_HOURS = ''
  process.env.DSH_OPT_READ_ONLY = 'false'
  await rm(root, { recursive: true, force: true })
})

after(async () => {
  await rm(TEST_TMP_ROOT, { recursive: true, force: true })
})

// ---------------------------------------------------------------------------
// Memory
// ---------------------------------------------------------------------------

describe('memory-store', () => {
  it('starts empty, applies curated ops and renders system.md without secrets', async () => {
    const initial = await memoryStore.readMemory()
    assert.equal(initial.schema_version, 1)
    assert.equal(initial.revision, 0)
    assert.deepEqual(initial.curated.preferences, [])
    assert.equal(initial.curated.backup_policy.weekly, true)
    assert.ok(initial.stale.includes('collected'))

    const updated = await memoryStore.updateMemory({
      ops: [
        { op: 'append', key: 'preferences', text: 'Call the room "living room", not "lounge".' },
        { op: 'set', key: 'hardware', value: ['Zigbee coordinator on /dev/ttyUSB1 (USB extension required).'] },
        { op: 'add_quirk', text: 'Kitchen motion sensor drops for ~2 min when the microwave runs.' },
        { op: 'record_change', entry: { kind: 'diagnosis', reason: 'microwave test', token: 'super-secret-token-123' } },
      ],
      reason: 'learned from the user',
      base_revision: 0,
    })
    assert.equal(updated.revision, 1)
    assert.ok(updated.changed.some((entry) => entry.startsWith('append preferences')))

    const memory = await memoryStore.readMemory({ fresh: true })
    assert.deepEqual(memory.curated.preferences, ['Call the room "living room", not "lounge".'])
    assert.equal(memory.curated.quirks.length, 1)
    assert.match(memory.curated.quirks[0].id, /^q_[a-z0-9]+$/)
    assert.equal(memory.curated.quirks[0].resolved, null)
    assert.equal(memory.summary.open_quirks, 1)
    assert.ok(memory.changelog_tail.length >= 2)

    const markdown = await readFile(memoryStore.memoryFiles().systemMd, 'utf8')
    assert.match(markdown, /Kitchen motion sensor drops/)
    assert.match(markdown, /## Collected inventory/)
    assert.ok(!markdown.includes('super-secret-token-123'), 'system.md must never contain secrets')

    const changelog = await readFile(memoryStore.memoryFiles().changelog, 'utf8')
    assert.ok(!changelog.includes('super-secret-token-123'), 'changelog must redact secrets')
    assert.ok(changelog.includes('[redacted]'))

    // resolve_quirk closes the loop
    const quirkId = memory.curated.quirks[0].id
    const resolved = await memoryStore.updateMemory({ ops: [{ op: 'resolve_quirk', id: quirkId }] })
    assert.equal(resolved.revision, 2)
    const afterResolve = await memoryStore.readMemory({ fresh: true })
    assert.notEqual(afterResolve.curated.quirks[0].resolved, null)
    await assert.rejects(
      memoryStore.updateMemory({ ops: [{ op: 'resolve_quirk', id: 'q_missing' }] }),
      (error) => error.code === 'NOT_FOUND',
    )
  })

  it('enforces revision CAS, the collected domain and the curated bounds', async () => {
    await memoryStore.updateMemory({ ops: [{ op: 'append', key: 'preferences', text: 'Plan first, then act.' }], base_revision: 0 })
    await assert.rejects(
      memoryStore.updateMemory({ ops: [{ op: 'append', key: 'preferences', text: 'x' }], base_revision: 0 }),
      (error) => {
        assert.equal(error.code, 'CONFLICT')
        assert.equal(error.data.revision, 1)
        return true
      },
    )
    // The tool exposes the conflict through the envelope, never by throwing.
    const conflict = await findTool('memory_update').execute({
      ops: [{ op: 'append', key: 'preferences', text: 'y' }],
      base_revision: 0,
    })
    assert.equal(conflict.ok, false)
    assert.equal(conflict.error.code, 'CONFLICT')

    await assert.rejects(
      memoryStore.updateMemory({ ops: [{ op: 'set', key: 'collected.versions', value: { ha: 'x' } }] }),
      (error) => error.code === 'FORBIDDEN',
    )
    await assert.rejects(
      memoryStore.updateMemory({ ops: [{ op: 'set', key: 'not_a_bucket', value: 1 }] }),
      (error) => error.code === 'INVALID_ARGUMENT',
    )
    await assert.rejects(
      memoryStore.updateMemory({
        ops: [{
          op: 'set',
          key: 'hardware',
          value: Array.from({ length: 300 }, (_value, index) => `hardware note ${index} `.repeat(20)),
        }],
      }),
      (error) => {
        assert.equal(error.code, 'INVALID_ARGUMENT')
        assert.ok(error.data.bytes > memoryStore.CURATED_MAX_BYTES)
        return true
      },
    )
    const tooMany = Array.from({ length: 130 }, (_value, index) => ({ op: 'add_quirk', text: `quirk number ${index}` }))
    await assert.rejects(
      memoryStore.updateMemory({ ops: tooMany }),
      (error) => error.code === 'INVALID_ARGUMENT',
    )
    // The entry budget (not just bytes) is enforced across calls.
    let entriesError = null
    for (let batch = 0; batch < 5 && entriesError === null; batch++) {
      try {
        await memoryStore.updateMemory({
          ops: Array.from({ length: 45 }, (_value, index) => ({ op: 'add_quirk', text: `batch ${batch} quirk ${index}` })),
        })
      } catch (error) {
        entriesError = error
      }
    }
    assert.ok(entriesError !== null, 'expected the curated entry budget to be enforced')
    assert.equal(entriesError.code, 'INVALID_ARGUMENT')
    assert.ok(entriesError.data.entries > memoryStore.CURATED_MAX_ENTRIES)
    const memory = await memoryStore.readMemory({ fresh: true })
    assert.ok(memory.summary.curated_entries <= memoryStore.CURATED_MAX_ENTRIES)
  })

  it('rotates the changelog at the configured byte budget', async () => {
    for (let index = 0; index < 5; index++) await memoryStore.recordChange({ kind: 'test', index })
    const file = memoryStore.memoryFiles().changelog
    assert.equal((await readFile(file, 'utf8')).trim().split('\n').length, 5)
    const rotated = await memoryStore.rotateChangelog({ max_bytes: 50, keep_lines: 2 })
    assert.equal(rotated.rotated, true)
    assert.equal(rotated.removed, 3)
    assert.equal((await readFile(file, 'utf8')).trim().split('\n').length, 2)
    const notRotated = await memoryStore.rotateChangelog({ max_bytes: 1_000_000 })
    assert.equal(notRotated.rotated, false)
  })

  it('collects the inventory deterministically and reports a diff', async () => {
    seedCollectScene()
    const first = await memoryStore.refreshCollected()
    assert.equal(first.changed, true)
    assert.ok(first.diff.changed_sections.includes('versions'))
    assert.equal(first.errors.length, 0)
    assert.ok(first.source.includes('GET /core/api/config'))

    const memory = await memoryStore.readMemory({ fresh: true })
    assert.equal(memory.collected.versions.ha, '2026.11.1')
    assert.equal(memory.collected.versions.supervisor, '2026.11.0')
    assert.equal(memory.collected.versions.os, '18.3')
    assert.equal(memory.collected.entities.total, 41)
    assert.equal(memory.collected.entities.unavailable, 2)
    assert.equal(memory.collected.integrations.count, 3)
    assert.ok(!memory.stale.includes('collected'))

    const baselines = await memoryStore.readBaselines()
    assert.equal(baselines.versions.ha, '2026.11.1')

    const second = await memoryStore.refreshCollected()
    assert.equal(second.changed, false)
    assert.deepEqual(second.diff.changed_sections, [])
    assert.equal(second.revision, first.revision)
  })
})

// ---------------------------------------------------------------------------
// Notifications
// ---------------------------------------------------------------------------

describe('notify', () => {
  it('suppresses severity < 3 in quiet hours but lets critical notifications through', async () => {
    router.on('/services/persistent_notification/create', () => jsonResponse({}), 'POST')
    process.env.DSH_OPT_QUIET_HOURS = currentQuietWindow()

    const quiet = await notify.notifyUser({ title: 'Warning', message: 'Severity 2', severity: 2 })
    assert.deepEqual(quiet.delivered, [])
    assert.deepEqual(quiet.suppressed, ['quiet_hours'])
    assert.equal(quiet.quiet_hours, true)
    assert.equal(router.count('/services/persistent_notification/create', 'POST'), 0)

    const critical = await notify.notifyUser({ title: 'Critical', message: 'Severity 4', severity: 4 })
    assert.deepEqual(critical.delivered, ['persistent_notification'])
    assert.equal(router.count('/services/persistent_notification/create', 'POST'), 1)
    const call = router.lastCall('/services/persistent_notification/create')
    assert.equal(call.headers.authorization, 'Bearer test-token-not-real')
    assert.match(call.body, /Severity 4/)
  })

  it('throttles repeats by dedupe_key and caps deliveries per hour', async () => {
    router.on('/services/persistent_notification/create', () => jsonResponse({}), 'POST')
    const first = await notify.notifyUser({ message: 'first', severity: 4, dedupe_key: 'k1' })
    assert.deepEqual(first.delivered, ['persistent_notification'])
    const duplicate = await notify.notifyUser({ message: 'first again', severity: 4, dedupe_key: 'k1' })
    assert.deepEqual(duplicate.suppressed, ['dedupe'])

    const second = await notify.notifyUser({ message: 'second', severity: 4, dedupe_key: 'k2' })
    const third = await notify.notifyUser({ message: 'third', severity: 4, dedupe_key: 'k3' })
    assert.equal(second.delivered.length, 1)
    assert.equal(third.delivered.length, 1)
    const fourth = await notify.notifyUser({ message: 'fourth', severity: 4, dedupe_key: 'k4' })
    assert.deepEqual(fourth.suppressed, ['rate_limit'])
    assert.equal(router.count('/services/persistent_notification/create', 'POST'), 3)

    const throttleState = await readFile(join(dataDir, 'monitor', 'notify-state.json'), 'utf8')
    assert.ok(!throttleState.includes('test-token-not-real'))
  })

  it('calls the optional notify service and reports channel errors', async () => {
    router.on('/services/persistent_notification/create', () => jsonResponse({}), 'POST')
    router.on('/services/notify/mobile_app_pixel', () => jsonResponse({}), 'POST')
    process.env.DSH_OPT_NOTIFY_SERVICE = 'notify.mobile_app_pixel'
    const result = await notify.notifyUser({ message: 'Hello', severity: 3, dedupe_key: 'svc' })
    assert.deepEqual(result.delivered, ['persistent_notification', 'notify.mobile_app_pixel'])
    const call = router.lastCall('/services/notify/mobile_app_pixel')
    assert.match(call.body, /mobile_app_pixel|Hello/)
    assert.ok(result.errors.length === 0)

    router.clearRoutes()
    router.on('/services/persistent_notification/create', () => jsonResponse({ message: 'boom' }, { status: 500 }), 'POST')
    const failing = await notify.notifyUser({ message: 'Hello again', severity: 3, dedupe_key: 'svc2' })
    assert.deepEqual(failing.delivered, [])
    assert.ok(failing.errors.some((error) => error.channel === 'persistent_notification'))
  })
})

// ---------------------------------------------------------------------------
// Monitoring
// ---------------------------------------------------------------------------

describe('monitor-store', () => {
  it('probe records findings, notifies once and dedupes within the cooldown', async () => {
    seedMonitorScene()
    router.on('/services/persistent_notification/create', () => jsonResponse({}), 'POST')

    const first = await monitorStore.probe({ deep: false, notify: true })
    assert.equal(first.enabled, true)
    const unavailable = first.findings.find((finding) => finding.check === 'entities.unavailable')
    assert.ok(unavailable, 'expected an entities.unavailable finding')
    assert.equal(unavailable.severity, 2)
    assert.ok(first.notified.length >= 1)
    const firstNotifications = router.count('/services/persistent_notification/create', 'POST')
    assert.ok(firstNotifications >= 1)
    assert.ok(first.recorded >= 1)

    const state = await monitorStore.readMonitorState()
    assert.ok(state.last_probe)
    assert.equal(state.baselines.unavailable_total, 6)
    assert.ok(state.baselines.unavailable_ids.length === 6)

    const second = await monitorStore.probe({ deep: false, notify: true })
    const suppressed = second.suppressed.find((entry) => entry.key === 'entities.unavailable')
    assert.ok(suppressed, 'expected the repeat finding to be suppressed')
    assert.equal(suppressed.reason, 'cooldown')
    assert.equal(second.notified.length, 0)
    assert.equal(second.recorded, 0)
    assert.equal(router.count('/services/persistent_notification/create', 'POST'), firstNotifications)

    const findingsFile = monitorStore.monitorFiles().findings
    const lines = (await readFile(findingsFile, 'utf8')).trim().split('\n')
    assert.equal(lines.length, first.recorded)
  })

  it('holds severity-2 notifications during quiet hours while still recording the finding', async () => {
    seedMonitorScene()
    router.on('/services/persistent_notification/create', () => jsonResponse({}), 'POST')
    await monitorStore.probe({ notify: false })
    const notificationsBefore = router.count('/services/persistent_notification/create', 'POST')

    process.env.DSH_OPT_QUIET_HOURS = currentQuietWindow()
    router.clearRoutes()
    seedMonitorScene({
      states: defaultStates({ unavailable: 0 }),
      backupDate: new Date(Date.now() - 8 * 86_400_000).toISOString(),
    })
    const quietProbe = await monitorStore.probe({ notify: true })
    const backupFinding = quietProbe.findings.find((finding) => finding.check === 'backups.fresh')
    assert.ok(backupFinding, 'expected an old-backup finding')
    assert.equal(backupFinding.severity, 2)
    const suppressed = quietProbe.suppressed.find((entry) => entry.key === 'backups.fresh')
    assert.ok(suppressed)
    assert.ok(suppressed.reasons.includes('quiet_hours'))
    assert.equal(router.count('/services/persistent_notification/create', 'POST'), notificationsBefore)
  })

  it('renders a bounded digest, sends it and persists the history', async () => {
    seedMonitorScene()
    router.on('/services/persistent_notification/create', () => jsonResponse({}), 'POST')
    await monitorStore.probe({ notify: false, deep: true })

    const result = await monitorStore.digest({ send: true, window_h: 24 })
    assert.ok(result.lines <= 20, `digest must stay <= 20 lines, got ${result.lines}`)
    assert.match(result.markdown, /Home Assistant — daily check/)
    assert.match(result.markdown, /Status:/)
    assert.equal(result.sent, true)
    assert.ok(result.delivered.includes('persistent_notification'))
    assert.ok(router.count('/services/persistent_notification/create', 'POST') >= 1)

    const state = await monitorStore.readMonitorState()
    assert.ok(state.last_digest)

    const history = await monitorStore.history({ limit: 20 })
    assert.ok(history.count >= 1)
    assert.ok(history.findings.every((finding) => typeof finding.ts === 'string'))

    const digestAgain = await monitorStore.digest({ send: false, window_h: 24 })
    assert.ok(digestAgain.lines <= 20)
  })

  it('validates configuration patches and persists them', async () => {
    const updated = await monitorStore.configure({
      patch: { cooldown_hours: 3, quiet_hours: '23:00-06:00', thresholds: { unavailable_ratio_warn: 0.2 } },
    })
    assert.equal(updated.config.cooldown_hours, 3)
    assert.equal(updated.config.quiet_hours, '23:00-06:00')
    assert.equal(updated.config.thresholds.unavailable_ratio_warn, 0.2)
    const reread = await monitorStore.configure({})
    assert.equal(reread.config.cooldown_hours, 3)
    await assert.rejects(monitorStore.configure({ patch: { cooldown_hours: 'soon' } }), (error) => error.code === 'INVALID_ARGUMENT')
    await assert.rejects(monitorStore.configure({ patch: { unknown_setting: 1 } }), (error) => error.code === 'INVALID_ARGUMENT')
    await assert.rejects(monitorStore.configure({ patch: { quiet_hours: '25:00-07:00' } }), (error) => error.code === 'INVALID_ARGUMENT')
  })

  it('honours the monitor_enabled add-on option', async () => {
    process.env.DSH_OPT_MONITOR_ENABLED = 'false'
    try {
      const disabled = await findTool('monitor_probe').execute({})
      assert.equal(disabled.ok, true)
      assert.equal(disabled.data.enabled, false)
      assert.equal(disabled.data.skipped_reason, 'monitor_disabled')
      const probeResult = await monitorStore.probe({ notify: true })
      assert.equal(probeResult.skipped_reason, 'monitor_disabled')
      assert.equal(probeResult.notified.length, 0)
    } finally {
      delete process.env.DSH_OPT_MONITOR_ENABLED
    }
  })
})

// ---------------------------------------------------------------------------
// Knowledge / news
// ---------------------------------------------------------------------------

describe('knowledge-store', () => {
  it('fetches conditionally, indexes, searches and degrades to cache offline', async () => {
    let served304 = 0
    router.on(
      (url) => url.includes('home-assistant.io/blog/feed.xml'),
      (call) => {
        if (call.headers['if-none-match'] === 'W/"feed-v1"') {
          served304 += 1
          return jsonResponse('', { status: 304, headers: { etag: 'W/"feed-v1"' } })
        }
        return jsonResponse(ATOM_FEED, { headers: { etag: 'W/"feed-v1"' } })
      },
    )
    router.on((url) => url.includes('api.github.com/repos/home-assistant/core/releases'), () => jsonResponse([
      {
        tag_name: '2026.11.1',
        name: '2026.11.1',
        published_at: new Date(Date.now() - 3_600_000).toISOString(),
        html_url: 'https://github.com/home-assistant/core/releases/tag/2026.11.1',
        body: '## Breaking changes\n\n- Recorder schema migration. Add Matter improvements.',
      },
    ], { headers: { etag: '"gh-v1"' } }))

    const first = await knowledgeStore.scan({ sources: ['ha.blog'] })
    const feedResult = first.results[0]
    assert.equal(feedResult.status, 'ok')
    assert.equal(first.new_count, 2)
    assert.equal(first.stale.length, 0)
    assert.equal(first.offline, false)
    assert.equal(router.lastCall('feed.xml').headers['if-none-match'], undefined)

    let index = await knowledgeStore.readIndex()
    assert.equal(index.items.length, 2)
    assert.ok(index.items.every((item) => item.url.startsWith('https://')))
    assert.ok(index.items.every((item) => item.excerpt.length <= 600))

    const second = await knowledgeStore.scan({ sources: ['ha.blog'] })
    assert.equal(second.results[0].status, 'not_modified')
    assert.equal(second.new_count, 0)
    assert.equal(served304, 1)
    assert.equal(router.lastCall('feed.xml').headers['if-none-match'], 'W/"feed-v1"')
    index = await knowledgeStore.readIndex()
    assert.equal(index.items.length, 2)

    const githubScan = await knowledgeStore.scan({ sources: ['gh.core.releases'] })
    assert.equal(githubScan.results[0].status, 'ok')
    assert.equal(githubScan.new_count, 1)
    index = await knowledgeStore.readIndex()
    assert.equal(index.items.length, 3)

    const found = await knowledgeStore.search({ query: 'matter improvements', k: 5 })
    assert.ok(found.count >= 1)
    const top = found.results[0]
    assert.ok(top.url.startsWith('https://'))
    assert.ok(top.excerpt.length <= 600)
    assert.equal(typeof top.score, 'number')
    assert.equal(top.body, undefined)

    const digestOne = await knowledgeStore.digest({ window_days: 30 })
    const digestTwo = await knowledgeStore.digest({ window_days: 30 })
    assert.equal(digestOne.markdown, digestTwo.markdown)
    assert.ok(digestOne.lines <= 15)
    assert.match(digestOne.markdown, /what's new/)

    // Going offline keeps the cache and labels the source stale.
    router.clearRoutes()
    router.on((url) => url.includes('home-assistant.io/blog/feed.xml'), () => {
      throw new TypeError('fetch failed')
    })
    const offline = await knowledgeStore.scan({ sources: ['ha.blog'], force: true })
    assert.equal(offline.offline, true)
    assert.deepEqual(offline.stale, ['ha.blog'])
    assert.equal(offline.new_count, 0)
    assert.equal(offline.results[0].status, 'error')
    index = await knowledgeStore.readIndex()
    assert.equal(index.items.length, 3)

    const digestOffline = await knowledgeStore.digest({ window_days: 30 })
    assert.match(digestOffline.markdown, /could not be refreshed/)
  })

  it('rejects unknown and non-public sources', async () => {
    assert.throws(() => knowledgeStore.resolveSource('evil.example'), (error) => error.code === 'INVALID_ARGUMENT')
    assert.throws(() => knowledgeStore.resolveSource('https://evil.example/feed.xml'), (error) => error.code === 'INVALID_ARGUMENT')
    const invalid = await knowledgeStore.scan({ sources: ['evil.example'] })
    assert.equal(invalid.results[0].status, 'invalid')
    assert.equal(invalid.new_count, 0)
    const noQuery = await knowledgeStore.search({ query: '' })
    assert.equal(noQuery.count, 0)
  })
})

// ---------------------------------------------------------------------------
// Local app builder
// ---------------------------------------------------------------------------

describe('addon-builder', () => {
  it('scaffolds a local app and validates it cleanly', async () => {
    const scaffolded = await builder.scaffold({
      name: 'My Test App',
      description: 'A test app for the unit tests.',
      type: 'node',
      interface: 'ingress',
      options: { log_level: 'info', target_url: '' },
      schema: { log_level: 'list(debug|info|warning|error)', target_url: 'str?' },
    })
    assert.equal(scaffolded.slug, 'my-test-app')
    assert.equal(scaffolded.interface, 'ingress')
    const dir = fixturePath(join('addons', 'my-test-app'))
    for (const file of ['config.yaml', 'Dockerfile', 'run.sh', 'README.md', 'DOCS.md', 'CHANGELOG.md', 'translations/en.yaml', 'app/index.js']) {
      const info = await stat(join(dir, file))
      assert.ok(info.isFile(), `expected ${file}`)
    }
    const runSh = await readFile(join(dir, 'run.sh'), 'utf8')
    assert.ok(!runSh.includes('\r'), 'run.sh must use LF line endings')
    assert.match(runSh, /^#!\/command\/with-contenv bashio/)
    assert.match(runSh, /# shellcheck shell=bash/)
    const config = await readFile(join(dir, 'config.yaml'), 'utf8')
    assert.match(config, /version: "0\.1\.0"/)
    assert.match(config, /init: false/)
    assert.match(config, /ingress: true/)
    assert.match(config, /ingress_port: 8099/)
    assert.match(config, /target_url: "str\?"/)

    const validated = await builder.validate('my-test-app')
    assert.deepEqual(validated.errors, [])
    assert.equal(validated.available, true)
    assert.equal(validated.version, '0.1.0')
    assert.ok(validated.files.includes('translations/en.yaml'))

    await assert.rejects(builder.scaffold({ name: 'My Test App' }), (error) => error.code === 'CONFLICT')
    const overwritten = await builder.scaffold({ name: 'My Test App', overwrite: true })
    assert.equal(overwritten.overwritten, true)
    assert.equal(overwritten.type, 'bash')
  })

  it('rejects bad slugs and reports lint errors and warnings', async () => {
    const badSlug = await findTool('addon_scaffold').execute({ name: 'Bad App', slug: 'Bad Slug!' })
    assert.equal(badSlug.ok, false)
    assert.equal(badSlug.error.code, 'INVALID_ARGUMENT')
    const reserved = await findTool('addon_scaffold').execute({ name: 'Reserved App', slug: 'config' })
    assert.equal(reserved.ok, false)

    const brokenDir = join(addonsDir, 'broken-app')
    await mkdir(brokenDir, { recursive: true })
    await writeFile(join(brokenDir, 'config.yaml'), 'name: Broken\nversion: 1.10\narch:\n  - armhf\ninit: true\nunknown_typo: yes\n')
    await writeFile(join(brokenDir, 'run.sh'), '#!/bin/sh\r\necho hi\r\n')
    await writeFile(join(brokenDir, 'Dockerfile'), 'FROM alpine\n')
    const broken = await builder.validate('broken-app')
    const codes = broken.errors.map((error) => error.code)
    assert.ok(codes.includes('VERSION_UNQUOTED'), `expected VERSION_UNQUOTED in ${codes.join(',')}`)
    assert.ok(codes.includes('MISSING_KEY'), `expected MISSING_KEY in ${codes.join(',')}`)
    assert.ok(codes.includes('UNKNOWN_KEY'))
    assert.ok(codes.includes('RUN_SH_CRLF'))
    assert.equal(broken.available, false)
    const warningCodes = broken.warnings.map((warning) => warning.code)
    assert.ok(warningCodes.includes('DEPRECATED_ARCH'))
    assert.ok(warningCodes.includes('INIT_TRUE'))

    const missing = await builder.validate('does-not-exist')
    assert.equal(missing.available, false)
    assert.equal(missing.errors[0].code, 'NOT_FOUND')
  })

  it('gates addon_build behind the option and a single-use confirmation token', async () => {
    await builder.scaffold({ name: 'Build Test', slug: 'build-test', type: 'bash' })
    const buildTool = findTool('addon_build')

    const denied = await buildTool.execute({ slug: 'build-test' })
    assert.equal(denied.ok, false)
    assert.equal(denied.error.code, 'FORBIDDEN')

    process.env.DSH_OPT_ALLOW_ADDON_MANAGEMENT = 'true'
    router.on('/store/reload', () => supOk({}), 'POST')
    router.on('/store/addons/local_build-test/install', () => supOk({ job_id: 'job-1' }), 'POST')
    router.on('/jobs/job-1', () => supOk({ done: true, progress: 100, stage: 'done', errors: [] }))

    const needsApproval = await buildTool.execute({ slug: 'build-test' })
    assert.equal(needsApproval.ok, false)
    assert.equal(needsApproval.error.code, 'NEEDS_APPROVAL')
    assert.equal(typeof needsApproval.data.token, 'string')
    assert.equal(needsApproval.data.target, builder.addonPath('build-test'))

    const confirmed = await buildTool.execute({ slug: 'build-test', confirmation_token: needsApproval.data.token })
    assert.equal(confirmed.ok, true, JSON.stringify(confirmed))
    assert.equal(confirmed.data.slug, 'build-test')
    assert.equal(confirmed.data.job_id, 'job-1')
    assert.equal(confirmed.data.done, true)
    assert.ok(router.count('/store/reload', 'POST') >= 1)

    const reused = await buildTool.execute({ slug: 'build-test', confirmation_token: needsApproval.data.token })
    assert.equal(reused.ok, false)
    assert.equal(reused.error.code, 'CONFLICT')
  })

  it('reports job failures with log tails', async () => {
    await builder.scaffold({ name: 'Fail Test', slug: 'fail-test', type: 'bash' })
    router.on('/store/reload', () => supOk({}), 'POST')
    router.on('/store/addons/local_fail-test/install', () => supOk({ job_id: 'job-fail' }), 'POST')
    router.on('/jobs/job-fail', () => supOk({ done: true, progress: 100, stage: 'done', errors: [{ message: 'docker build failed' }] }))
    router.on('/addons/fail-test/logs', () => jsonResponse('ERROR: build failed') )
    router.on('/supervisor/logs', () => jsonResponse('Supervisor log tail'))

    const result = await builder.build({ slug: 'fail-test', interval_ms: 10 })
    assert.equal(result.ok, false)
    assert.match(result.error, /reported 1 error/)
    assert.match(result.logs.addon, /build failed/)
    assert.match(result.logs.supervisor, /Supervisor log tail/)
    assert.ok(result.hints.length >= 1)
  })
})

// ---------------------------------------------------------------------------
// Tool definitions
// ---------------------------------------------------------------------------

describe('tool definitions', () => {
  const EXPECTED_NAMES = [
    'addon_build',
    'addon_scaffold',
    'addon_validate',
    'ha_news_digest',
    'ha_news_scan',
    'knowledge_search',
    'memory_get',
    'memory_refresh',
    'memory_update',
    'monitor_configure',
    'monitor_digest',
    'monitor_history',
    'monitor_probe',
    'notify_user',
  ]

  it('exports 14 definitions with the exact names, classes and envelope contract', () => {
    assert.equal(memoryTools, memoryToolsNamed, 'memory module must export the same array by name and default')
    const definitions = [
      ...memoryTools,
      ...monitorTools,
      ...knowledgeTools,
      ...builderTools,
      ...notifyTools,
    ]
    assert.deepEqual(definitions.map((definition) => definition.name).sort(), EXPECTED_NAMES)
    assert.equal(definitions.length, 14)
    for (const definition of definitions) {
      assert.equal(typeof definition.description, 'string')
      assert.ok(definition.description.length > 20, `${definition.name} needs a useful description`)
      assert.equal(definition.xClass, classify(definition.name), `${definition.name} xClass must match safety.js`)
      assert.equal(definition.parameters.type, 'object')
      assert.equal(definition.parameters.additionalProperties, false)
      assert.equal(definition.output.schema.type, 'object')
      assert.equal(definition.output.schema.additionalProperties, true)
      assert.equal(typeof definition.output.render, 'function')
      assert.equal(typeof definition.execute, 'function')
    }
    for (const name of ['memory_update', 'monitor_configure', 'addon_scaffold']) {
      assert.equal(findTool(name).xClass, 'SW')
    }
    assert.equal(findTool('addon_build').xClass, 'DIS')
    assert.equal(findTool('memory_get').xClass, 'R')
    assert.equal(findTool('monitor_digest').xClass, 'ACT')
    assert.equal(findTool('notify_user').xClass, 'ACT')
    assert.equal(findTool('addon_validate').xClass, 'R')
  })

  it('returns envelopes and never throws out of execute', async () => {
    const getEnvelope = await findTool('memory_get').execute({})
    assert.equal(getEnvelope.ok, true)
    assert.equal(typeof getEnvelope.summary, 'string')
    assert.ok(Array.isArray(getEnvelope.warnings))
    assert.ok(getEnvelope.meta && typeof getEnvelope.meta.fetched_at === 'string')
    assert.equal(typeof getEnvelope.meta.source, 'object')
    assert.ok(!JSON.stringify(getEnvelope).includes('test-token-not-real'))

    const failure = await findTool('memory_update').execute({ ops: [{ op: 'bogus' }] })
    assert.equal(failure.ok, false)
    assert.equal(failure.error.code, 'INVALID_ARGUMENT')
    assert.equal(typeof failure.error.message, 'string')

    const invalidArgs = await findTool('memory_update').execute({})
    assert.equal(invalidArgs.ok, false)
    assert.equal(invalidArgs.error.code, 'INVALID_ARGUMENT')

    const history = await findTool('monitor_history').execute({ limit: 5 })
    assert.equal(history.ok, true)
    assert.equal(typeof history.data.count, 'number')

    const scaffold = await findTool('addon_scaffold').execute({ name: 'Envelope App' })
    assert.equal(scaffold.ok, true)
    assert.equal(scaffold.data.slug, 'envelope-app')
    const validate = await findTool('addon_validate').execute({ slug: 'envelope-app' })
    assert.equal(validate.ok, true)
    assert.equal(validate.data.available, true)
  })

  it('keeps the read-only mode safe for notification side effects', async () => {
    seedMonitorScene()
    process.env.DSH_OPT_READ_ONLY = 'true'
    const probeEnvelope = await findTool('monitor_probe').execute({ notify: true })
    assert.equal(probeEnvelope.ok, false)
    assert.equal(probeEnvelope.error.code, 'FORBIDDEN')
    const digestEnvelope = await findTool('monitor_digest').execute({ send: true })
    assert.equal(digestEnvelope.ok, false)
    assert.equal(digestEnvelope.error.code, 'FORBIDDEN')
    const readBackEnvelope = await findTool('monitor_configure').execute({ get: true })
    assert.equal(readBackEnvelope.ok, true)
    assert.ok(readBackEnvelope.data.config)
  })
})
