/**
 * Offline unit tests for the core plugin tools: Home Assistant Core (`ha_*`),
 * Supervisor (`sup_*`), config files (`config_*`) and the one-shot WebSocket
 * diagnostics client.
 *
 * `globalThis.fetch` and `globalThis.WebSocket` are stubbed; no test opens a
 * network connection. Run from the workspace root:
 *
 *   node --test tests/plugin/core.test.mjs
 */

import assert from 'node:assert/strict'
import { readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { after, before, beforeEach, test } from 'node:test'

import {
  classify,
  filterTools,
  pendingConfirmationCount,
  resetConfirmations,
  TOOL_CLASSES,
} from '../../deepseek_harness/rootfs/opt/ha-dsh/lib/safety.js'
import { sha256 } from '../../deepseek_harness/rootfs/opt/ha-dsh/lib/result.js'
import { deriveWsUrl } from '../../deepseek_harness/rootfs/opt/ha-dsh/lib/ha-ws.js'
import haTools from '../../deepseek_harness/rootfs/opt/ha-dsh/plugin/tools/ha.js'
import supTools from '../../deepseek_harness/rootfs/opt/ha-dsh/plugin/tools/sup.js'
import configTools from '../../deepseek_harness/rootfs/opt/ha-dsh/plugin/tools/config.js'
import {
  jsonRouter,
  makeCtx,
  makeTempWorkspace,
  registerDefinitions,
  response,
  setEnv,
  stubFetch,
} from './helpers.mjs'

// ---------------------------------------------------------------------------
// Expected catalogue (docs/research/ha-domain.md Appendix A subset owned here)
// ---------------------------------------------------------------------------

const HA_NAMES = [
  'ha_get_config',
  'ha_get_states',
  'ha_get_state',
  'ha_get_services',
  'ha_get_history',
  'ha_get_logbook',
  'ha_get_error_log',
  'ha_get_config_check',
  'ha_render_template',
  'ha_list_automations',
  'ha_call_service',
  'ha_reload',
  'ha_restart',
  'ha_list_registry',
  'ha_get_repairs',
  'ha_get_system_log',
  'ha_get_automation_trace',
]

const SUP_NAMES = [
  'sup_get_info',
  'sup_get_resolution',
  'sup_get_updates',
  'sup_list_addons',
  'sup_get_addon',
  'sup_addon_logs',
  'sup_get_store',
  'sup_get_logs',
  'sup_backup_list',
  'sup_backup_info',
  'sup_backup_create',
  'sup_backup_restore',
  'sup_job_status',
  'sup_store_reload',
  'sup_set_addon_options',
  'sup_addon_start',
  'sup_addon_stop',
  'sup_addon_restart',
  'sup_addon_install',
  'sup_addon_update',
  'sup_addon_uninstall',
  'sup_addon_rebuild',
  'sup_core_update',
]

const CONFIG_NAMES = [
  'config_list',
  'config_read',
  'config_search',
  'config_write',
  'config_edit',
  'config_delete',
  'config_snapshot',
  'config_restore',
]

const ALL_MODULES = [haTools, supTools, configTools]
const ALL_DEFINITIONS = ALL_MODULES.flat()
/** Read-only registration count: 14 ha + 11 sup + 3 config + config_snapshot. */
const READ_ONLY_COUNT = 29

// ---------------------------------------------------------------------------
// Global offline setup
// ---------------------------------------------------------------------------

const restoreBaselineEnv = setEnv({
  SUPERVISOR_TOKEN: 'test-token',
  DSH_SUPERVISOR_URL: 'http://supervisor',
  DSH_OPT_READ_ONLY: 'false',
  DSH_OPT_ALLOW_RESTARTS: 'false',
  DSH_OPT_ALLOW_ADDON_MANAGEMENT: 'false',
})

/** @type {{ restore: () => void } | null} */
let networkGuard = null

before(() => {
  networkGuard = stubFetch((call) => new Error(`Unexpected network call in test: ${call.method} ${call.url}`))
})

after(async () => {
  networkGuard?.restore()
  restoreBaselineEnv()
  resetConfirmations()
  await rm(join(process.cwd(), 'tests', '.tmp'), { recursive: true, force: true })
})

beforeEach(() => {
  resetConfirmations()
})

/**
 * Create an isolated workspace + fetch stub + fake context, and register the
 * three core tool modules exactly like `plugin/index.js` would.
 * @param {import('node:test').TestContext} t
 * @param {{ routes?: object[], supervisorUrl?: string, mode?: { readOnly?: boolean } }} [options]
 */
async function withFixture(t, options = {}) {
  const workspace = await makeTempWorkspace({ supervisorUrl: options.supervisorUrl })
  const fetchStub = stubFetch(jsonRouter(options.routes ?? []))
  const ctx = makeCtx()
  registerDefinitions(ctx, ALL_DEFINITIONS, options.mode ?? { readOnly: false })
  t.after(async () => {
    fetchStub.restore()
    await workspace.cleanup()
    resetConfirmations()
  })
  return { workspace, ctx, fetchStub }
}

/** Flush pending microtasks/timers for the WebSocket handshake. */
const nextTick = () => new Promise((resolve) => setTimeout(resolve, 0))

/** Fake browser/Node WebSocket client used to drive `lib/ha-ws.js` offline. */
class FakeWebSocket {
  static instances = []
  constructor(url) {
    this.url = url
    this.sent = []
    this.closed = false
    this.listeners = new Map()
    FakeWebSocket.instances.push(this)
  }
  addEventListener(type, listener) {
    if (!this.listeners.has(type)) this.listeners.set(type, [])
    this.listeners.get(type).push(listener)
  }
  send(raw) {
    this.sent.push(JSON.parse(raw))
  }
  close() {
    this.closed = true
    this.emit('close', {})
  }
  emit(type, event) {
    for (const listener of this.listeners.get(type) ?? []) listener(event)
  }
  emitJson(value) {
    this.emit('message', { data: JSON.stringify(value) })
  }
}

// ---------------------------------------------------------------------------
// Catalogue + capability filtering
// ---------------------------------------------------------------------------

test('tool catalogue: 48 definitions with the exact Appendix A names and xClass values', () => {
  assert.equal(ALL_DEFINITIONS.length, 48)
  const names = ALL_DEFINITIONS.map((definition) => definition.name)
  assert.deepEqual([...names].sort(), [...HA_NAMES, ...SUP_NAMES, ...CONFIG_NAMES].sort())

  for (const definition of ALL_DEFINITIONS) {
    assert.equal(typeof definition.description, 'string', `${definition.name} description`)
    assert.ok(definition.description.length > 10, `${definition.name} description is too short`)
    assert.equal(definition.parameters.type, 'object', `${definition.name} parameters`)
    assert.equal(definition.parameters.additionalProperties, false, `${definition.name} parameters.additionalProperties`)
    assert.deepEqual(
      definition.output.schema,
      { type: 'object', additionalProperties: true },
      `${definition.name} output schema`,
    )
    assert.equal(typeof definition.output.render, 'function', `${definition.name} render`)
    assert.equal(typeof definition.execute, 'function', `${definition.name} execute`)
    assert.ok(definition.xClass, `${definition.name} xClass`)
    assert.equal(definition.xClass, classify(definition.name), `${definition.name} class matches safety.js`)
    assert.ok(TOOL_CLASSES[definition.name], `${definition.name} is in TOOL_CLASSES`)
  }

  // Sanity-check the class split of the mutable tools owned by this task.
  assert.equal(classify('ha_restart'), 'DIS')
  assert.equal(classify('ha_call_service'), 'ACT')
  assert.equal(classify('ha_reload'), 'ACT')
  assert.equal(classify('config_delete'), 'DES')
  assert.equal(classify('config_write'), 'SW')
  assert.equal(classify('sup_addon_uninstall'), 'DES')
  assert.equal(classify('sup_backup_restore'), 'DES')
  assert.equal(classify('sup_core_update'), 'DIS')
})

test('read_only mode keeps only R tools plus config_snapshot', () => {
  const filtered = filterTools(ALL_DEFINITIONS, { readOnly: true })
  assert.equal(filtered.length, READ_ONLY_COUNT)
  const names = new Set(filtered.map((definition) => definition.name))
  for (const definition of filtered) {
    assert.ok(
      definition.xClass === 'R' || definition.name === 'config_snapshot',
      `${definition.name} must be read-only`,
    )
  }
  assert.ok(names.has('config_snapshot'))
  for (const excluded of [
    'config_write',
    'config_edit',
    'config_delete',
    'config_restore',
    'ha_call_service',
    'ha_reload',
    'ha_restart',
    'sup_addon_start',
    'sup_set_addon_options',
    'sup_backup_create',
    'sup_store_reload',
  ]) {
    assert.ok(!names.has(excluded), `${excluded} must not be registered read-only`)
  }
})

test('registration composes modules, strips xClass and indexes tools by name', () => {
  const fullCtx = makeCtx()
  registerDefinitions(fullCtx, ALL_DEFINITIONS, { readOnly: false })
  assert.equal(fullCtx.registered.length, 48)
  for (const definition of fullCtx.registered) {
    assert.equal(Object.hasOwn(definition, 'xClass'), false, `${definition.name} xClass must be stripped`)
  }
  assert.equal(typeof fullCtx.get('ha_get_state').execute, 'function')
  assert.equal(typeof fullCtx.get('config_write').execute, 'function')

  const readOnlyCtx = makeCtx()
  registerDefinitions(readOnlyCtx, ALL_DEFINITIONS, { readOnly: true })
  assert.equal(readOnlyCtx.registered.length, READ_ONLY_COUNT)
  assert.ok(readOnlyCtx.get('config_snapshot'))
  assert.equal(readOnlyCtx.get('ha_restart'), undefined)
})

// ---------------------------------------------------------------------------
// Read envelope + Supervisor URL / auth
// ---------------------------------------------------------------------------

test('ha_get_config returns the canonical envelope and hits the Supervisor proxy', async (t) => {
  const { ctx, fetchStub } = await withFixture(t, {
    routes: [
      {
        method: 'GET',
        match: /\/core\/api\/config$/,
        body: {
          version: '2026.11.1',
          location_name: 'Home',
          time_zone: 'Europe/Warsaw',
          unit_system: { length: 'km' },
          components: ['light', 'sensor'],
        },
      },
      { method: 'GET', match: /\/core\/api\/core\/state$/, body: { state: 'RUNNING' } },
      { method: 'GET', match: /\/core\/api\/components$/, body: ['light', 'sensor'] },
    ],
  })

  const result = await ctx.get('ha_get_config').execute({})
  assert.deepEqual(Object.keys(result), ['ok', 'summary', 'data', 'warnings', 'meta'])
  assert.equal(result.ok, true)
  assert.match(result.summary, /2026\.11\.1/)
  assert.equal(result.data.version, '2026.11.1')
  assert.equal(result.data.core_state.state, 'RUNNING')
  assert.equal(result.data.components_count, 2)
  assert.ok(Array.isArray(result.warnings))
  assert.equal(typeof result.meta.fetched_at, 'string')
  assert.ok(result.meta.source.includes('GET /api/config'))
  assert.deepEqual(
    fetchStub.calls.map((call) => call.url),
    [
      'http://supervisor/core/api/config',
      'http://supervisor/core/api/core/state',
      'http://supervisor/core/api/components',
    ],
  )
  for (const call of fetchStub.calls) {
    assert.equal(call.headers.authorization, 'Bearer test-token')
  }
  assert.ok(!JSON.stringify(result).includes('test-token'), 'the Supervisor token must never leak into results')
})

test('supervisor base URL, bearer header and missing-token behaviour', async (t) => {
  const { ctx, fetchStub } = await withFixture(t, {
    supervisorUrl: 'http://supervisor:9999',
    routes: [
      {
        method: 'GET',
        match: /\/info$/,
        body: { arch: 'amd64', machine: 'generic-x86-64', healthy: true, timezone: 'Europe/Warsaw' },
      },
    ],
  })
  const result = await ctx.get('sup_get_info').execute({ sections: ['system'] })
  assert.equal(result.ok, true)
  assert.equal(fetchStub.calls[0].url, 'http://supervisor:9999/info')
  assert.equal(fetchStub.calls[0].method, 'GET')
  assert.equal(fetchStub.calls[0].headers.authorization, 'Bearer test-token')
  assert.equal(result.data.summary.arch, 'amd64')

  const restore = setEnv({ SUPERVISOR_TOKEN: undefined })
  try {
    const unusable = await ctx.get('sup_get_info').execute({ sections: ['system'] })
    assert.equal(unusable.ok, false)
    assert.equal(unusable.error.code, 'FORBIDDEN')
    assert.equal(fetchStub.calls.length, 1, 'no request may be made without a token')
  } finally {
    restore()
  }
})

test('sup_get_addon redacts secret-looking option values', async (t) => {
  const { ctx } = await withFixture(t, {
    routes: [
      {
        method: 'GET',
        match: /\/addons\/core_mosquitto\/info$/,
        body: { name: 'Mosquitto broker', version: '6.5.1', options: { password: 'hunter2', port: 1883 } },
      },
    ],
  })
  const hidden = await ctx.get('sup_get_addon').execute({ slug: 'core_mosquitto' })
  assert.equal(hidden.ok, true)
  assert.equal(hidden.data.options, undefined)
  assert.deepEqual(hidden.data.option_keys, ['password', 'port'])

  const shown = await ctx.get('sup_get_addon').execute({ slug: 'core_mosquitto', include_options: true })
  assert.equal(shown.ok, true)
  assert.equal(shown.data.options.password, '[redacted]')
  assert.equal(shown.data.options.port, 1883)
  assert.ok(!JSON.stringify(shown).includes('hunter2'), 'secret option values must be redacted')
})

// ---------------------------------------------------------------------------
// Service-call safety
// ---------------------------------------------------------------------------

test('ha_call_service refuses denied domains and the dedicated restart action', async (t) => {
  const { ctx, fetchStub } = await withFixture(t)
  for (const args of [
    { domain: 'shell_command', service: 'backup' },
    { domain: 'python_script', service: 'turn_on' },
    { domain: 'pyscript', service: 'x' },
    { domain: 'hassio', service: 'host_reboot' },
    { domain: 'homeassistant', service: 'restart', data: {} },
    { domain: 'homeassistant', service: 'stop', data: {} },
  ]) {
    const result = await ctx.get('ha_call_service').execute(args)
    assert.equal(result.ok, false, `${args.domain}.${args.service} must be refused`)
    assert.equal(result.error.code, 'FORBIDDEN')
  }
  assert.equal(fetchStub.calls.length, 0)
})

test('safety-domain service call: NEEDS_APPROVAL, then executes once, CONFLICT on changed args', async (t) => {
  const { ctx, fetchStub } = await withFixture(t, {
    routes: [{ method: 'POST', match: /\/core\/api\/services\/lock\/unlock$/, body: [] }],
  })
  const call = (args) => ctx.get('ha_call_service').execute(args)
  const base = { domain: 'lock', service: 'unlock', data: { entity_id: 'lock.front_door' } }

  const approval = await call(base)
  assert.equal(approval.ok, false)
  assert.equal(approval.error.code, 'NEEDS_APPROVAL')
  assert.equal(typeof approval.data.token, 'string')
  assert.match(approval.data.action, /lock\.unlock/)
  assert.equal(typeof approval.data.impact, 'string')
  assert.equal(typeof approval.data.expires_at, 'string')
  assert.equal(fetchStub.calls.length, 0, 'the dry run must not call Home Assistant')

  const executed = await call({ ...base, confirmation_token: approval.data.token })
  assert.equal(executed.ok, true)
  assert.equal(fetchStub.calls.length, 1)
  const serviceCall = fetchStub.calls[0]
  assert.equal(serviceCall.method, 'POST')
  assert.equal(serviceCall.url, 'http://supervisor/core/api/services/lock/unlock')
  assert.equal(serviceCall.body.entity_id, 'lock.front_door')

  // A fresh approval, then an argument change → CONFLICT and no extra call.
  const fresh = await call(base)
  assert.equal(fresh.ok, false)
  assert.equal(fresh.error.code, 'NEEDS_APPROVAL')
  const conflict = await call({
    ...base,
    data: { entity_id: 'lock.back_door' },
    confirmation_token: fresh.data.token,
  })
  assert.equal(conflict.ok, false)
  assert.equal(conflict.error.code, 'CONFLICT')
  assert.equal(fetchStub.calls.length, 1)

  // Single use: replaying the consumed token is a conflict.
  const replay = await call({ ...base, confirmation_token: approval.data.token })
  assert.equal(replay.ok, false)
  assert.equal(replay.error.code, 'CONFLICT')
  assert.equal(fetchStub.calls.length, 1)
  assert.equal(pendingConfirmationCount(), 0)
})

test('ha_restart is option gated and requires a confirmation token', async (t) => {
  const { ctx, fetchStub } = await withFixture(t, {
    routes: [{ method: 'POST', match: /\/core\/restart$/, body: { result: 'ok' } }],
  })
  const restart = (args) => ctx.get('ha_restart').execute(args)

  const gated = await restart({ reason: 'apply template sensor' })
  assert.equal(gated.ok, false)
  assert.equal(gated.error.code, 'FORBIDDEN')
  assert.match(gated.error.hint, /allow_restarts/)

  const restore = setEnv({ DSH_OPT_ALLOW_RESTARTS: 'true' })
  try {
    const approval = await restart({ reason: 'apply template sensor' })
    assert.equal(approval.ok, false)
    assert.equal(approval.error.code, 'NEEDS_APPROVAL')
    assert.equal(typeof approval.data.token, 'string')
    assert.match(approval.data.impact, /unavailable/i)

    const executed = await restart({ reason: 'apply template sensor', confirmation_token: approval.data.token })
    assert.equal(executed.ok, true)
    assert.equal(fetchStub.calls.length, 1)
    assert.equal(fetchStub.calls[0].url, 'http://supervisor/core/restart')
    assert.deepEqual(fetchStub.calls[0].body, { safe_mode: false, force: false })
  } finally {
    restore()
  }
})

// ---------------------------------------------------------------------------
// Config filesystem safety
// ---------------------------------------------------------------------------

test('config_write snapshots, then rolls back when the config check is invalid', async (t) => {
  const { workspace, ctx, fetchStub } = await withFixture(t, {
    routes: [
      {
        method: 'POST',
        match: /\/core\/api\/config\/core\/check_config$/,
        body: { result: 'invalid', errors: 'bad indentation' },
      },
    ],
  })
  const original = 'automation:\n  - alias: Old\n    trigger: []\n'
  await writeFile(join(workspace.configDir, 'automations.yaml'), original, 'utf8')

  const result = await ctx.get('config_write').execute({
    path: 'automations.yaml',
    content: 'automation:\n\t- alias: Broken\n',
    base_sha256: sha256(original),
    label: 'test-rollback',
  })
  assert.equal(result.ok, false)
  assert.equal(result.error.code, 'INVALID_ARGUMENT')
  assert.equal(result.data.rolled_back, true)
  assert.equal(result.data.validation.result, 'invalid')
  assert.equal(typeof result.data.snapshot_id, 'string')
  assert.equal(await readFile(join(workspace.configDir, 'automations.yaml'), 'utf8'), original)

  const snapshots = await readdir(join(workspace.dataDir, 'config-backups'))
  assert.equal(snapshots.length, 1)
  const snapshotDir = join(workspace.dataDir, 'config-backups', snapshots[0])
  const manifest = JSON.parse(await readFile(join(snapshotDir, 'manifest.json'), 'utf8'))
  assert.equal(manifest.entries.length, 1)
  assert.equal(manifest.entries[0].path, 'automations.yaml')
  assert.equal(manifest.entries[0].existed, true)
  assert.equal(await readFile(join(snapshotDir, 'files', 'automations.yaml'), 'utf8'), original)
  assert.ok(fetchStub.calls.some((call) => call.method === 'POST' && call.url.endsWith('/check_config')))
})

test('config_write keeps a valid change and a stale base_sha256 is a CONFLICT', async (t) => {
  const { workspace, ctx } = await withFixture(t, {
    routes: [
      {
        method: 'POST',
        match: /\/core\/api\/config\/core\/check_config$/,
        body: { result: 'valid', errors: null, warnings: [] },
      },
    ],
  })
  const original = 'template:\n  - sensor: []\n'
  const next = 'template:\n  - sensor:\n      - name: Test\n        state: "{{ 1 + 1 }}"\n'
  await writeFile(join(workspace.configDir, 'configuration.yaml'), original, 'utf8')

  const written = await ctx.get('config_write').execute({
    path: 'configuration.yaml',
    content: next,
    base_sha256: sha256(original),
  })
  assert.equal(written.ok, true)
  assert.equal(written.data.created, false)
  assert.equal(written.data.validation.valid, true)
  assert.equal(written.data.validation.checked, true)
  assert.equal(written.data.diff.changed, true)
  assert.ok(written.data.diff.unified.includes('+template:') || written.data.diff.unified.includes(' template:'))
  assert.equal(await readFile(join(workspace.configDir, 'configuration.yaml'), 'utf8'), next)

  const stale = await ctx.get('config_write').execute({
    path: 'configuration.yaml',
    content: 'overwritten: true\n',
    base_sha256: sha256(original),
  })
  assert.equal(stale.ok, false)
  assert.equal(stale.error.code, 'CONFLICT')
  assert.equal(stale.data.reason, 'STALE_BASE')
  assert.equal(stale.data.current_sha256, sha256(next))
  assert.equal(await readFile(join(workspace.configDir, 'configuration.yaml'), 'utf8'), next)
})

test('config paths reject traversal, runtime files, databases and secrets', async (t) => {
  const { workspace, ctx } = await withFixture(t)
  await writeFile(join(workspace.configDir, 'secrets.yaml'), 'api_key: super-secret\n', 'utf8')

  const cases = [
    { tool: 'config_read', args: { path: '../../etc/passwd' } },
    { tool: 'config_read', args: { path: '.storage/core.config_entries' } },
    { tool: 'config_read', args: { path: 'home-assistant_v2.db' } },
    { tool: 'config_read', args: { path: 'secrets.yaml' } },
    { tool: 'config_write', args: { path: '../escape.yaml', content: 'x: 1\n' } },
    { tool: 'config_list', args: { path: '.storage' } },
    { tool: 'config_search', args: { query: 'key', path: '.cloud' } },
  ]
  for (const item of cases) {
    const result = await ctx.get(item.tool).execute(item.args)
    assert.equal(result.ok, false, `${item.tool} ${JSON.stringify(item.args)} must be refused`)
    assert.equal(result.error.code, 'FORBIDDEN', `${item.tool} ${JSON.stringify(item.args)}`)
  }
})

test('config_delete needs a token and allow_core_files for core config files', async (t) => {
  const { workspace, ctx } = await withFixture(t)
  const original = 'default_config:\n'
  const path = join(workspace.configDir, 'configuration.yaml')
  await writeFile(path, original, 'utf8')

  const coreFile = await ctx.get('config_delete').execute({
    path: 'configuration.yaml',
    base_sha256: sha256(original),
  })
  assert.equal(coreFile.ok, false)
  assert.equal(coreFile.error.code, 'FORBIDDEN')
  assert.match(coreFile.error.message, /allow_core_files/)

  const args = { path: 'configuration.yaml', base_sha256: sha256(original), allow_core_files: true }
  const approval = await ctx.get('config_delete').execute(args)
  assert.equal(approval.ok, false)
  assert.equal(approval.error.code, 'NEEDS_APPROVAL')
  assert.equal(approval.data.facts.current_sha256, sha256(original))
  assert.equal(await readFile(path, 'utf8'), original)

  const deleted = await ctx.get('config_delete').execute({ ...args, confirmation_token: approval.data.token })
  assert.equal(deleted.ok, true)
  assert.equal(deleted.data.deleted, true)
  assert.equal(typeof deleted.data.snapshot_id, 'string')
  await assert.rejects(readFile(path, 'utf8'))

  const snapshots = await readdir(join(workspace.dataDir, 'config-backups'))
  assert.ok(snapshots.length >= 1)
})

test('config_snapshot and config_restore round-trip behind a confirmation token', async (t) => {
  const { workspace, ctx } = await withFixture(t, {
    routes: [
      {
        method: 'POST',
        match: /\/core\/api\/config\/core\/check_config$/,
        body: { result: 'valid', errors: null },
      },
    ],
  })
  const path = join(workspace.configDir, 'automations.yaml')
  const original = 'automation:\n  - alias: Keep me\n'
  await writeFile(path, original, 'utf8')

  const snapshot = await ctx.get('config_snapshot').execute({
    paths: ['automations.yaml'],
    label: 'before-edit',
  })
  assert.equal(snapshot.ok, true)
  assert.equal(typeof snapshot.data.snapshot_id, 'string')
  assert.equal(snapshot.data.entries.length, 1)

  await writeFile(path, 'automation: []\n', 'utf8')

  const gated = await ctx.get('config_restore').execute({ snapshot_id: snapshot.data.snapshot_id })
  assert.equal(gated.ok, false)
  assert.equal(gated.error.code, 'NEEDS_APPROVAL')
  assert.equal(gated.data.facts.entries, 1)
  assert.equal(await readFile(path, 'utf8'), 'automation: []\n')

  const restored = await ctx.get('config_restore').execute({
    snapshot_id: snapshot.data.snapshot_id,
    confirmation_token: gated.data.token,
  })
  assert.equal(restored.ok, true)
  assert.equal(restored.data.restored[0].action, 'restored')
  assert.equal(restored.data.validation.valid, true)
  assert.equal(await readFile(path, 'utf8'), original)
})

// ---------------------------------------------------------------------------
// WebSocket diagnostics
// ---------------------------------------------------------------------------

test('deriveWsUrl maps the Supervisor URL to the HA WebSocket proxy', () => {
  assert.equal(deriveWsUrl('http://supervisor'), 'ws://supervisor/core/websocket')
  assert.equal(deriveWsUrl('http://supervisor/'), 'ws://supervisor/core/websocket')
  assert.equal(deriveWsUrl('https://ha.local'), 'wss://ha.local/core/websocket')
  assert.equal(deriveWsUrl('ws://supervisor'), 'ws://supervisor/core/websocket')
  assert.throws(() => deriveWsUrl('ftp://supervisor'), /Unsupported Supervisor URL/)
})

test('WebSocket diagnostics authenticate, send one command and map unknown commands to UNSUPPORTED', async (t) => {
  const originalWebSocket = globalThis.WebSocket
  const { ctx } = await withFixture(t)
  globalThis.WebSocket = FakeWebSocket
  FakeWebSocket.instances = []
  t.after(() => {
    globalThis.WebSocket = originalWebSocket
    FakeWebSocket.instances = []
  })

  const pending = ctx.get('ha_list_registry').execute({ kind: 'entities' })
  await nextTick()
  const socket = FakeWebSocket.instances.at(-1)
  assert.equal(socket.url, 'ws://supervisor/core/websocket')

  socket.emitJson({ type: 'auth_required' })
  await nextTick()
  assert.deepEqual(socket.sent[0], { type: 'auth', access_token: 'test-token' })

  socket.emitJson({ type: 'auth_ok', ha_version: '2026.11.1' })
  await nextTick()
  assert.equal(socket.sent[1].type, 'config/entity_registry/list')
  const commandId = socket.sent[1].id
  assert.equal(typeof commandId, 'number')

  socket.emitJson({
    type: 'result',
    id: commandId,
    success: true,
    result: [{ entity_id: 'light.kitchen' }, { entity_id: 'sensor.outside' }],
  })
  const result = await pending
  assert.equal(result.ok, true)
  assert.equal(result.data.kind, 'entities')
  assert.equal(result.data.items.length, 2)
  assert.ok(result.meta.source.some((item) => item.startsWith('WS ')))
  assert.equal(socket.closed, true, 'the one-shot connection must be closed')

  const repairs = ctx.get('ha_get_repairs').execute({})
  await nextTick()
  const second = FakeWebSocket.instances.at(-1)
  second.emitJson({ type: 'auth_required' })
  await nextTick()
  second.emitJson({ type: 'auth_ok' })
  await nextTick()
  second.emitJson({
    type: 'result',
    id: second.sent[1].id,
    success: false,
    error: { code: 'unknown_command', message: 'Unknown command.' },
  })
  const unsupported = await repairs
  assert.equal(unsupported.ok, false)
  assert.equal(unsupported.error.code, 'UNSUPPORTED')
  assert.match(unsupported.error.message, /Settings → System → Repairs/)
})

test('WebSocket tools stay offline-safe without a Supervisor token', async (t) => {
  const { ctx } = await withFixture(t)
  const restore = setEnv({ SUPERVISOR_TOKEN: undefined })
  try {
    const result = await ctx.get('ha_get_repairs').execute({})
    assert.equal(result.ok, false)
    assert.equal(result.error.code, 'FORBIDDEN')
    assert.match(result.error.message, /SUPERVISOR_TOKEN/)
  } finally {
    restore()
  }
  assert.equal(response({ ok: true }).ok, true)
})

// ---------------------------------------------------------------------------
// Optional integration: plugin/index.js once all teammate modules exist
// ---------------------------------------------------------------------------

test('plugin/index.js mounts the full bundle when all tool modules are present', async (t) => {
  let index
  try {
    index = await import('../../deepseek_harness/rootfs/opt/ha-dsh/plugin/index.js')
  } catch (error) {
    t.skip(`teammate tool modules are not present yet: ${error.message}`)
    return
  }
  const ctx = makeCtx()
  const logs = []
  const originalLog = console.log
  console.log = (...args) => logs.push(args.join(' '))
  let registered = 0
  try {
    registered = index.apply(ctx)
  } finally {
    console.log = originalLog
  }
  assert.equal(registered, ctx.registered.length)
  assert.ok(registered >= 60)
  // Extended knowledge/dashboard tools live in tools/extras.js and are mounted too.
  for (const name of ['ha_get_dashboard', 'ha_save_dashboard', 'ha_compat_scan', 'ha_recommend']) {
    assert.ok(ctx.names().includes(name), `missing extended tool ${name}`)
  }
  const expected = [...HA_NAMES, ...SUP_NAMES, ...CONFIG_NAMES]
  for (const name of expected) assert.ok(ctx.names().includes(name), `missing ${name}`)
  for (const definition of ctx.registered) assert.equal(Object.hasOwn(definition, 'xClass'), false)
  assert.ok(logs.some((line) => /\[ha-deepseek-harness\] registered \d+ tools \(read_only=(true|false)\)/.test(line)))
})
