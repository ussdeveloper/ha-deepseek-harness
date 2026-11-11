/**
 * Test helpers for the plugin unit tests: fake Cordis context, offline `fetch`
 * router/stub, temporary DSH directories and environment handling.
 *
 * Every helper is dependency-free and offline; nothing in here opens a socket.
 */

import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'

import { filterTools } from '../../deepseek_harness/rootfs/opt/ha-dsh/lib/safety.js'

/**
 * Minimal fetch Response stand-in: only what the plugin clients use.
 * @param {unknown} body string or JSON-serialisable value
 * @param {{ status?: number }} [options]
 * @returns {{ ok: boolean, status: number, text: () => Promise<string> }}
 */
export function response(body, options = {}) {
  const status = options.status ?? 200
  const text = typeof body === 'string' ? body : body === undefined ? '' : JSON.stringify(body)
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => text,
    json: async () => JSON.parse(text),
  }
}

/** @param {unknown} pattern @param {string} url @returns {boolean} */
function matches(pattern, url) {
  if (pattern instanceof RegExp) return pattern.test(url)
  return url.includes(String(pattern))
}

/**
 * Build a fetch handler that answers from a route table.
 * Each route: `{ method?, match: string|RegExp, status?, body }` where `body` may
 * be a function of the captured call.
 * @param {Array<{method?: string, match: string|RegExp, status?: number, body?: unknown}>} routes
 * @returns {(call: object) => object}
 */
export function jsonRouter(routes) {
  return (call) => {
    for (const route of routes) {
      if (route.method !== undefined && String(route.method).toUpperCase() !== call.method) continue
      if (!matches(route.match, call.url)) continue
      const body = typeof route.body === 'function' ? route.body(call) : route.body
      return response(body === undefined ? {} : body, { status: route.status ?? 200 })
    }
    return response({ message: `Unrouted request in test: ${call.method} ${call.url}` }, { status: 404 })
  }
}

/**
 * Install a fake `globalThis.fetch`. Calls are recorded; an Error result is
 * thrown to simulate a network failure. Restores the previous fetch on demand.
 * @param {(call: {url: string, method: string, headers: Record<string,string>, body: unknown}, calls: object[]) => unknown} handler
 * @returns {{ calls: object[], restore: () => void }}
 */
export function stubFetch(handler) {
  const original = globalThis.fetch
  /** @type {object[]} */
  const calls = []
  globalThis.fetch = async (input, init = {}) => {
    const url = typeof input === 'string' ? input : String(input?.url ?? input)
    const method = String(init.method ?? 'GET').toUpperCase()
    const headers = init.headers ?? {}
    let body = init.body
    if (typeof body === 'string') {
      try {
        body = JSON.parse(body)
      } catch {
        /* keep the raw text */
      }
    }
    const call = { url, method, headers, body, signal: init.signal }
    calls.push(call)
    const result = await handler(call, calls)
    if (result instanceof Error) throw result
    if (result === undefined) return response({ ok: true })
    return result
  }
  return {
    calls,
    restore() {
      globalThis.fetch = original
    },
  }
}

/**
 * Set/delete environment variables and return a restore function.
 * @param {Record<string, string|undefined>} vars
 * @returns {() => void}
 */
export function setEnv(vars) {
  const previous = {}
  for (const [key, value] of Object.entries(vars)) {
    previous[key] = process.env[key]
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
  return () => {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  }
}

/**
 * Create an isolated config/data/addons tree and point the plugin env at it.
 *
 * The temp root lives inside the workspace (`tests/.tmp/`): the DSH Windows
 * sandbox grants write access to the workspace, while `os.tmpdir()` may be
 * outside it (mkdtemp there fails with EPERM under confinement).
 * @param {{ token?: string|undefined, supervisorUrl?: string }} [options]
 * @returns {Promise<{ root: string, configDir: string, dataDir: string, addonsDir: string, cleanup: () => Promise<void> }>}
 */
export async function makeTempWorkspace(options = {}) {
  const tempRoot = join(process.cwd(), 'tests', '.tmp')
  await mkdir(tempRoot, { recursive: true })
  const root = await mkdtemp(join(tempRoot, 'dsh-core-test-'))
  const configDir = join(root, 'config')
  const dataDir = join(root, 'data')
  const addonsDir = join(root, 'addons')
  await mkdir(configDir, { recursive: true })
  await mkdir(dataDir, { recursive: true })
  await mkdir(addonsDir, { recursive: true })
  const restoreEnv = setEnv({
    DSH_HA_CONFIG_DIR: configDir,
    DSH_DATA_DIR: dataDir,
    DSH_HA_ADDONS_DIR: addonsDir,
    DSH_SUPERVISOR_URL: options.supervisorUrl ?? 'http://supervisor',
    SUPERVISOR_TOKEN: options.token ?? 'test-token',
    DSH_OPT_READ_ONLY: 'false',
    DSH_OPT_ALLOW_RESTARTS: 'false',
    DSH_OPT_ALLOW_ADDON_MANAGEMENT: 'false',
  })
  return {
    root,
    configDir,
    dataDir,
    addonsDir,
    async cleanup() {
      restoreEnv()
      await rm(root, { recursive: true, force: true })
    },
  }
}

/**
 * Fake Cordis context whose `tools.register` records definitions by name.
 * @returns {{ registered: object[], tools: { register(def: object): void, get(name: string): object|undefined }, get(name: string): object|undefined, names: () => string[] }}
 */
export function makeCtx() {
  /** @type {object[]} */
  const registered = []
  /** @type {Map<string, object>} */
  const byName = new Map()
  const register = (definition) => {
    if (!definition || typeof definition.name !== 'string') throw new Error('tool definition without a name')
    if (byName.has(definition.name)) throw new Error(`duplicate tool registration: ${definition.name}`)
    registered.push(definition)
    byName.set(definition.name, definition)
  }
  return {
    registered,
    tools: { register, get: (name) => byName.get(name) },
    get: (name) => byName.get(name),
    names: () => registered.map((definition) => definition.name),
  }
}

/**
 * Register tool definitions the way `plugin/index.js` does: capability filter,
 * `xClass` stripped, then `ctx.tools.register`.
 * @param {ReturnType<typeof makeCtx>} ctx
 * @param {object[]} definitions
 * @param {{ readOnly?: boolean }} [mode]
 * @returns {object[]} registered definitions
 */
export function registerDefinitions(ctx, definitions, mode = {}) {
  const filtered = filterTools(definitions, mode)
  for (const definition of filtered) {
    const { xClass, ...registration } = definition
    void xClass
    ctx.tools.register(registration)
  }
  return ctx.registered
}
