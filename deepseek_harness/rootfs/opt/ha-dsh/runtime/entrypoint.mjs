/**
 * Add-on entrypoint: prepares the persistent state, then supervises the three
 * long-running processes of the add-on.
 *
 *   1. dsh web          — the agent Web UI, bound to loopback only
 *   2. ingress-shim.mjs — authenticated reverse proxy on the ingress port
 *   3. collector.mjs    — deterministic memory / monitor / news loop
 *
 * Responsibilities kept out of DSH itself: mapping Home Assistant add-on
 * options to environment variables, restoring managed files from the image,
 * capturing the DSH launch token for the shim, restarting background helpers,
 * and forwarding termination signals so the Supervisor can stop us cleanly.
 *
 * @module entrypoint
 */

import { spawn, spawnSync } from 'node:child_process'
import { createWriteStream, existsSync } from 'node:fs'
import { appendFile, copyFile, mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises'
import { hostExec } from '../lib/host-access.js'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

import { runFirstRun } from './first-run.mjs'
import { VERSION } from '../lib/paths.js'

const OPTIONS_PATH = '/data/options.json'
const RUNTIME_DIR = '/data/runtime'
const TOKEN_FILE = join(RUNTIME_DIR, 'dsh-token')
const LOG_FILE = '/data/dsh-home/addon.log'
const DSH_HOME = process.env.DSH_HOME ?? '/data/dsh-home'
const WEB_PORT = Number.parseInt(process.env.DSH_WEB_PORT ?? '3080', 10)
const INGRESS_PORT = Number.parseInt(process.env.DSH_INGRESS_PORT ?? '8099', 10)
const PLUGIN_PATCH = '/opt/ha-dsh/plugin/cordis.patch.yml'
const PROFILE_PATCH = '/opt/ha-dsh/profile.patch.yml'
const COLLECTOR = '/opt/ha-dsh/runtime/collector.mjs'
const SHIM = '/opt/ha-dsh/runtime/ingress-shim.mjs'
const MANAGED_AGENTS = '/opt/ha-dsh/prompts/AGENTS.md'
// The agent's working directory lives in the Home Assistant config folder so
// the user can see its files and HA backups include them.
const CONFIG_DIR = '/config'
const WORKSPACE = '/config/deepseek-harness'

/** Simple structured logger; Home Assistant captures stdout/stderr. */
function log(level, message) {
  const line = `${new Date().toISOString()} [entrypoint] ${level} ${message}`
  process.stdout.write(`${line}\n`)
  // Mirror into the add-on log so the authenticated /__logs shim endpoint can
  // expose startup problems through ingress.
  appendFile(LOG_FILE, `${line}\n`).catch(() => {})
}

/** Read /data/options.json; an absent file is not an error (direct docker run). */
async function readOptions() {
  try {
    return JSON.parse(await readFile(OPTIONS_PATH, 'utf8'))
  } catch (error) {
    if (error?.code === 'ENOENT') return {}
    log('WARN', `cannot read ${OPTIONS_PATH}: ${error?.message ?? error}`)
    return {}
  }
}

/**
 * Normalise the configured API base URL for DSH's DeepSeek provider.
 *
 * DSH talks to DeepSeek through the Anthropic-compatible endpoint
 * (`https://api.deepseek.com/anthropic`). Users often enter just
 * `https://api.deepseek.com`, which would send `/v1/messages` to the wrong
 * path and fail with HTTP 404.
 * @param {string} value
 * @returns {string}
 */
export function normalizeDeepSeekBaseUrl(value) {
  const trimmed = String(value ?? '').trim().replace(/\/+$/, '')
  if (trimmed === '') return trimmed
  try {
    const url = new URL(trimmed)
    if (url.hostname === 'api.deepseek.com' && (url.pathname === '' || url.pathname === '/')) {
      return 'https://api.deepseek.com/anthropic'
    }
  } catch {
    return trimmed
  }
  return trimmed
}

/**
 * Resolve the DSH permission preset from the add-on options.
 * @param {{ read_only?: unknown, full_access?: unknown }} options
 * @returns {'read-only'|'workspace-write'|'danger-full-access'}
 */
export function resolvePermissionMode(options) {
  if (options.read_only === true) return 'read-only'
  if (options.full_access === false) return 'workspace-write'
  return 'danger-full-access'
}

/** @param {Record<string, unknown>} options */
function exportOptions(options) {
  const mapping = [
    ['model', 'DSH_OPT_MODEL'],
    ['base_url', 'DSH_OPT_BASE_URL'],
    ['read_only', 'DSH_OPT_READ_ONLY'],
    ['full_access', 'DSH_OPT_FULL_ACCESS'],
    ['allow_restarts', 'DSH_OPT_ALLOW_RESTARTS'],
    ['allow_addon_management', 'DSH_OPT_ALLOW_ADDON_MANAGEMENT'],
    ['allow_host_management', 'DSH_OPT_ALLOW_HOST_MANAGEMENT'],
    ['protection_mode', 'DSH_OPT_PROTECTION_MODE'],
    ['monitor_enabled', 'DSH_OPT_MONITOR_ENABLED'],
    ['first_run_analysis', 'DSH_OPT_FIRST_RUN_ANALYSIS'],
    ['notify_service', 'DSH_OPT_NOTIFY_SERVICE'],
    ['backup_retention', 'DSH_OPT_BACKUP_RETENTION'],
    ['quiet_hours', 'DSH_OPT_QUIET_HOURS'],
    ['public_url', 'DSH_OPT_PUBLIC_URL'],
  ]
  for (const [key, env] of mapping) {
    const value = options[key]
    if (value === undefined || value === null) continue
    process.env[env] = typeof value === 'boolean' ? String(value) : String(value)
  }
  // DSH credential fallback names (the UI-saved key still wins).
  const apiKey = options.deepseek_api_key
  if (typeof apiKey === 'string' && apiKey.trim() !== '') {
    process.env.DEEPSEEK_API_KEY = apiKey.trim()
  }
  const baseUrl = options.base_url
  if (typeof baseUrl === 'string' && baseUrl.trim() !== '') {
    process.env.DEEPSEEK_BASE_URL = normalizeDeepSeekBaseUrl(baseUrl)
  }
  // Read-only always wins. Otherwise full access is the default: inside the
  // add-on container the DSH workspace sandbox would only get in the way of
  // repairing the local instance, while the plugin's confirmation-token gates
  // and the safety prompt still constrain actions.
  const permissionMode = resolvePermissionMode(options)
  process.env.DSH_PERMISSION_MODE = permissionMode
  process.env.DSH_OPT_PERMISSION_MODE = permissionMode
}

/**
 * Find a DeepSeek API key in the Home Assistant configuration file.
 *
 * Users often keep add-on settings next to their HA configuration, e.g.:
 *
 *   deepseek_harness:
 *     api_key: sk-…
 *
 * Reading it at start (when neither the add-on option nor the environment
 * provides a key) means a fresh install can talk to the model without copying
 * the secret into the add-on options a second time.
 * @param {string} text configuration.yaml contents
 * @returns {string|undefined}
 */
export function extractApiKeyFromConfiguration(text) {
  const lines = String(text).split(/\r?\n/)
  let inBlock = false
  let blockIndent = 0
  for (const line of lines) {
    if (!inBlock) {
      // Accept deepseek_harness, deepseek-harness and deepseekharness; users
      // write the block by hand and the underscore-less form is common.
      const block = /^(deepseek[_-]?harness)\s*:\s*(.*)$/.exec(line)
      if (block === null) continue
      const inline = block[2].trim()
      if (inline !== '' && !inline.startsWith('#')) {
        const inlineKey = /(?:api[_-]?key|deepseek_api_key|api|token|key|password)\s*:\s*([^,}]+)/i.exec(inline)
        if (inlineKey !== null) {
          const value = inlineKey[1].trim().replace(/^["']|["',]$/g, '')
          if (value !== '' && !/^(null|~)$/i.test(value)) return value
        }
        continue
      }
      inBlock = true
      blockIndent = 0
      continue
    }
    if (line.trim() === '' || /^\s*#/.test(line)) continue
    const indent = (line.match(/^\s*/) ?? [''])[0].length
    if (indent === 0) break
    if (blockIndent === 0) blockIndent = indent
    if (indent < blockIndent) break
    const match = /^\s*(?:api[_-]?key|deepseek_api_key|api|token|key|password)\s*:\s*(.+?)\s*$/.exec(line)
    if (match !== null) {
      const value = match[1].replace(/\s+#.*$/, '').trim().replace(/^["']|["']$/g, '')
      if (value !== '' && !/^(null|~)$/i.test(value)) return value
    }
  }
  return undefined
}

/**
 * Apply a key found in `/config/configuration.yaml` when no higher-precedence
 * key is configured. The value is placed in the process environment only.
 */
async function applyConfigurationApiKey() {
  const fromOptions = typeof process.env.DEEPSEEK_API_KEY === 'string' && process.env.DEEPSEEK_API_KEY.trim() !== ''
  if (fromOptions) {
    log('INFO', `API key provided by add-on options/environment (length ${process.env.DEEPSEEK_API_KEY.trim().length})`)
    return true
  }
  try {
    const text = await readFile(join(CONFIG_DIR, 'configuration.yaml'), 'utf8')
    const key = extractApiKeyFromConfiguration(text)
    if (key === undefined) {
      log('WARN', 'no DeepSeek API key in add-on options or /config/configuration.yaml')
      return false
    }
    process.env.DEEPSEEK_API_KEY = key
    log('INFO', `using DeepSeek API key from /config/configuration.yaml (length ${key.length})`)
    return true
  } catch (error) {
    log('WARN', `could not read /config/configuration.yaml: ${error instanceof Error ? error.message : String(error)}`)
    return false
  }
}

/**
 * On a fresh install, make sure the add-on appears in the Home Assistant
 * sidebar. Supervisor stores the panel toggle as app option `ingress_panel`;
 * installs driven by the API can leave it off even when ingress is declared.
 */
async function ensureIngressPanel() {
  const marker = '/data/.panel-initialized'
  if (existsSync(marker)) return
  const token = process.env.SUPERVISOR_TOKEN
  if (typeof token !== 'string' || token === '') return
  try {
    const response = await fetch('http://supervisor/addons/self/info', {
      headers: { authorization: `Bearer ${token}` },
    })
    if (response.ok) {
      const info = await response.json()
      if (info?.ingress === true && info?.ingress_panel !== true) {
        const update = await fetch('http://supervisor/addons/self/options', {
          method: 'POST',
          headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
          body: JSON.stringify({ ingress_panel: true }),
        })
        log('INFO', update.ok ? 'enabled the sidebar panel' : `could not enable the sidebar panel (HTTP ${update.status})`)
      }
    }
    await writeFile(marker, `${JSON.stringify({ initializedAt: new Date().toISOString() }, null, 2)}\n`, { mode: 0o600 })
  } catch (error) {
    log('WARN', `sidebar panel check failed: ${error instanceof Error ? error.message : String(error)}`)
  }
}

/**
 * Enforce the requested protection-mode state through the Supervisor API.
 *
 * The add-on has the admin role, so it can toggle its own protection mode. The
 * default (option `protection_mode: false`) disables protection; the Supervisor
 * restarts the app so the container receives `docker_api`, `host_pid` and
 * `full_access`. A short-lived marker prevents a restart loop if the toggle is
 * refused or ignored.
 */
async function ensureProtectionMode(options) {
  const token = process.env.SUPERVISOR_TOKEN
  if (typeof token !== 'string' || token === '') return
  const desired = options.protection_mode === true
  const marker = '/data/.protection-toggle'
  try {
    const infoResponse = await fetch('http://supervisor/addons/self/info', {
      headers: { authorization: `Bearer ${token}` },
    })
    if (!infoResponse.ok) return
    const info = await infoResponse.json()
    if (info.protected === desired) {
      log('INFO', `protection mode: ${desired ? 'on' : 'off'}`)
      return
    }
    const lastAttempt = existsSync(marker) ? (await readFile(marker, 'utf8')).trim() : ''
    if (lastAttempt !== '') {
      const attemptedAt = Date.parse(lastAttempt)
      if (Number.isFinite(attemptedAt) && Date.now() - attemptedAt < 5 * 60_000) {
        log('WARN', `protection mode is still ${info.protected ? 'on' : 'off'}; skipping repeated toggle`)
        return
      }
    }
    await writeFile(marker, new Date().toISOString(), { mode: 0o600 })
    const update = await fetch('http://supervisor/addons/self/security', {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ protected: desired }),
    })
    log(
      update.ok
        ? `INFO protection mode changed to ${desired ? 'on' : 'off'}; the Supervisor will restart the add-on to apply host grants`
        : `WARN could not change protection mode (HTTP ${update.status})`,
    )
    await new Promise((resolve) => setTimeout(resolve, 3_000))
  } catch (error) {
    log('WARN', `protection mode check failed: ${error instanceof Error ? error.message : String(error)}`)
  }
}

/** Log whether host-level access is actually available after the grants apply. */
async function logHostAccess() {
  const hostRoot = existsSync('/proc/1/root')
  const dockerSocket = ['/run/docker.sock', '/var/run/docker.sock'].find((path) => existsSync(path)) ?? 'none'
  let nsenter = 'missing'
  try {
    const result = spawnSync('nsenter', ['-t', '1', '-m', '--', 'true'], { timeout: 3_000, stdio: 'ignore' })
    nsenter = result.status === 0 ? 'ok' : `exit ${result.status ?? 'error'}`
  } catch {
    nsenter = 'error'
  }
  let hostExecResult = 'skipped'
  try {
    const result = await hostExec('uname -s; id -u; ls -1 / | head -5', { timeoutMs: 10_000 })
    hostExecResult = `via=${result.via} exit=${result.exitCode} out=${JSON.stringify(result.stdout.trim().slice(0, 200))}`
  } catch (error) {
    hostExecResult = `failed: ${error instanceof Error ? error.message : String(error)}`
  }
  log(
    `host access: hostRoot=${hostRoot ? 'ok' : 'no'} dockerSocket=${dockerSocket} nsenter=${nsenter} hostExec(${hostExecResult})`,
  )
}

/** Create the persistent directory layout. */
async function ensureDirectories() {  for (const directory of [
    RUNTIME_DIR,
    DSH_HOME,
    join(DSH_HOME, 'skills'),
    join(DSH_HOME, 'sessions'),
    WORKSPACE,
    '/data/memory',
    '/data/monitor',
    '/data/knowledge',
    '/data/config-backups',
  ]) {
    await mkdir(directory, { recursive: true })
  }
}

/** Copy a managed file over its writable copy when it differs (or is missing). */
async function restoreManaged(source, target) {
  try {
    const desired = await readFile(source)
    const current = await readFile(target).catch(() => null)
    if (current !== null && Buffer.compare(current, desired) === 0) return
    await mkdir(join(target, '..'), { recursive: true })
    const temp = `${target}.${process.pid}.tmp`
    await writeFile(temp, desired)
    await rename(temp, target)
    log('INFO', `restored managed file ${target}`)
  } catch (error) {
    log('WARN', `cannot restore ${target} from ${source}: ${error?.message ?? error}`)
  }
}

/**
 * Copy the image's skill bundles into the DSH user skill root
 * (`$DSH_HOME/skills`), refreshing any file whose content changed.
 */
async function restoreSkills() {
  const sourceRoot = '/opt/ha-dsh/skills'
  const targetRoot = join(DSH_HOME, 'skills')
  let entries = []
  try {
    entries = await readdir(sourceRoot, { withFileTypes: true })
  } catch {
    log('WARN', `no managed skills found at ${sourceRoot}`)
    return
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    const source = join(sourceRoot, entry.name, 'SKILL.md')
    const target = join(targetRoot, entry.name, 'SKILL.md')
    if (!existsSync(source)) continue
    try {
      const desired = await readFile(source)
      const current = await readFile(target).catch(() => null)
      if (current !== null && Buffer.compare(current, desired) === 0) continue
      await mkdir(join(targetRoot, entry.name), { recursive: true })
      await copyFile(source, target)
      log('INFO', `installed skill ${entry.name}`)
    } catch (error) {
      log('WARN', `cannot install skill ${entry.name}: ${error?.message ?? error}`)
    }
  }
}

/**
 * Spawn a long-running child with line-buffered stdout/stderr forwarding.
 * @param {string} name
 * @param {string} command
 * @param {string[]} args
 * @param {{ cwd?: string, env?: NodeJS.ProcessEnv, onLine?: (line: string) => void }} [options]
 */
function startChild(name, command, args, options = {}) {
  const child = spawn(command, args, {
    cwd: options.cwd ?? WORKSPACE,
    env: { ...process.env, ...options.env },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  const forward = (stream, level) => {
    let buffered = ''
    stream.setEncoding('utf8')
    stream.on('data', (chunk) => {
      buffered += chunk
      let index = buffered.indexOf('\n')
      while (index !== -1) {
        const line = buffered.slice(0, index).replace(/\r$/, '')
        buffered = buffered.slice(index + 1)
        if (line.trim() !== '') {
          process.stdout.write(`${new Date().toISOString()} [${name}] ${line}\n`)
          options.onLine?.(line)
        }
        index = buffered.indexOf('\n')
      }
    })
    stream.on('end', () => {
      if (buffered.trim() !== '') options.onLine?.(buffered)
    })
    void level
  }
  forward(child.stdout)
  forward(child.stderr)
  child.on('error', (error) => log('ERROR', `${name} failed to start: ${error.message}`))
  return child
}

/** Extract the DSH browser launch token from its startup output. */
async function captureToken(line) {
  if (!line.includes('dsh web:')) return
  const urlMatch = /dsh web:\s*(\S+)/.exec(line)
  const raw = urlMatch?.[1] ?? ''
  let token = ''
  try {
    token = new URL(raw).searchParams.get('token') ?? ''
  } catch {
    token = /[?&]token=([A-Za-z0-9._~-]+)/.exec(raw)?.[1] ?? ''
  }
  if (token === '') return
  try {
    await writeFile(TOKEN_FILE, token, { mode: 0o600 })
    log('INFO', 'captured DSH launch token for the ingress shim')
  } catch (error) {
    log('WARN', `cannot write launch token: ${error?.message ?? error}`)
  }
  return
}

const children = new Map()
let shuttingDown = false

/** Terminate all children and exit. */
async function shutdown(reason, code = 0) {
  if (shuttingDown) return
  shuttingDown = true
  log('INFO', `shutting down (${reason})`)
  for (const [name, child] of children) {
    if (child.exitCode === null) {
      log('INFO', `sending SIGTERM to ${name}`)
      child.kill('SIGTERM')
    }
  }
  const deadline = Date.now() + 12_000
  while (Date.now() < deadline) {
    const running = [...children.values()].filter((child) => child.exitCode === null)
    if (running.length === 0) break
    await new Promise((resolve) => setTimeout(resolve, 200))
  }
  for (const [name, child] of children) {
    if (child.exitCode === null) {
      log('WARN', `${name} did not stop in time; SIGKILL`)
      child.kill('SIGKILL')
    }
  }
  process.exit(code)
}

/** Main bootstrap. */
async function main() {
  const options = await readOptions()
  exportOptions(options)
  await ensureDirectories()
  await applyConfigurationApiKey()
  await ensureProtectionMode(options)
  await ensureIngressPanel()

  await restoreManaged(MANAGED_AGENTS, join(DSH_HOME, 'AGENTS.md'))

  // Skills are served from the read-only image root via DSH_BUNDLED_SKILL_DIR,
  // so they cannot drift or be shadowed by files under /data.

  // Trim a stale token so the shim never injects a token from a previous boot.
  await rm(TOKEN_FILE, { force: true })

  const logStream = createWriteStream(LOG_FILE, { flags: 'a', mode: 0o600 })
  logStream.on('error', (error) => log('WARN', `log file unavailable: ${error.message}`))

  // The shim listens immediately so the Supervisor watchdog and ingress are
  // reachable while the first-run recognition runs; it answers 502 until DSH
  // is up. This keeps a slow first boot from looking like a failed start.
  const shim = startChild('shim', process.execPath, [SHIM], {
    env: {
      DSH_WEB_PORT: String(WEB_PORT),
      DSH_INGRESS_PORT: String(INGRESS_PORT),
      DSH_TOKEN_FILE: TOKEN_FILE,
      DSH_DEFAULT_SESSION_FILE: join(RUNTIME_DIR, 'default-session.json'),
    },
  })
  children.set('shim', shim)

  // One-time system recognition runs in the background after the UI is up:
  // the deterministic report appears within seconds and the optional LLM
  // assessment creates the first-run session without delaying installation or
  // the first page load.
  const startFirstRun = () => {
    setTimeout(() => {
      void runFirstRun().catch((error) => {
        log('WARN', `first-run recognition failed: ${error instanceof Error ? error.message : String(error)}`)
      })
    }, 10_000)
  }

  const web = startChild(
    'dsh',
    'dsh',
    [
      'web',
      '--patch',
      PROFILE_PATCH,
      '--patch',
      PLUGIN_PATCH,
      '--no-open',
      '--host',
      '127.0.0.1',
      '--port',
      String(WEB_PORT),
      '--trusted-host',
      'dsh.local',
    ],
    {
      env: {
        DSH_HOME,
        DSH_WEB_PORT: String(WEB_PORT),
        DSH_ADDON_VERSION: VERSION,
        HOME: '/data',
      },
      onLine: (line) => {
        logStream.write(`${new Date().toISOString()} [dsh] ${line}\n`)
        void captureToken(line)
      },
    },
  )
  children.set('dsh', web)

  const collector = startChild('collector', process.execPath, [COLLECTOR], {
    env: { DSH_HOME },
  })
  children.set('collector', collector)

  // Diagnostics only: never block the UI on host probing.
  void logHostAccess()

  startFirstRun()

  // DSH is the foreground process: when it exits the add-on stops and the
  // Supervisor decides whether to restart the container.
  web.on('exit', (code, signal) => {
    log('WARN', `dsh exited (code=${code ?? 'null'} signal=${signal ?? 'null'})`)
    void shutdown('dsh exit', typeof code === 'number' && code !== 0 ? code : 1)
  })

  // Background helpers are restarted with a bounded backoff.
  const restarts = new Map()
  for (const [name, child] of [
    ['shim', shim],
    ['collector', collector],
  ]) {
    child.on('exit', (code, signal) => {
      if (shuttingDown) return
      const count = (restarts.get(name) ?? 0) + 1
      restarts.set(name, count)
      const delay = Math.min(30_000, 1_000 * 2 ** Math.min(count, 5))
      log('WARN', `${name} exited (code=${code ?? 'null'} signal=${signal ?? 'null'}); restarting in ${delay} ms`)
      setTimeout(() => {
        if (shuttingDown) return
        if (name === 'shim') {
          const next = startChild('shim', process.execPath, [SHIM], {
            env: {
              DSH_WEB_PORT: String(WEB_PORT),
              DSH_INGRESS_PORT: String(INGRESS_PORT),
              DSH_TOKEN_FILE: TOKEN_FILE,
            },
          })
          children.set('shim', next)
          next.on('exit', (nextCode, nextSignal) => {
            if (shuttingDown) return
            log('WARN', `shim exited again (code=${nextCode ?? 'null'} signal=${nextSignal ?? 'null'})`)
          })
        } else {
          const next = startChild('collector', process.execPath, [COLLECTOR], { env: { DSH_HOME } })
          children.set('collector', next)
        }
      }, delay)
    })
  }

  process.on('SIGTERM', () => void shutdown('SIGTERM', 0))
  process.on('SIGINT', () => void shutdown('SIGINT', 0))

  log(
    'INFO',
    `DeepSeek Harness starting: web=127.0.0.1:${WEB_PORT}, ingress=0.0.0.0:${INGRESS_PORT}, permission=${process.env.DSH_PERMISSION_MODE}, read_only=${
      options.read_only === true
    }, monitor=${options.monitor_enabled !== false}`,
  )
  logStream.write(`${new Date().toISOString()} [entrypoint] started\n`)
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (!existsSync('/opt/ha-dsh')) {
    log('WARN', 'expected image tree /opt/ha-dsh is missing; running from a non-add-on environment')
  }

  await main()
}



