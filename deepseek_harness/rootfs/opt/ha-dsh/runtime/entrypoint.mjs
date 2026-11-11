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

import { spawn } from 'node:child_process'
import { createWriteStream } from 'node:fs'
import { copyFile, mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join } from 'node:path'

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
const WORKSPACE = '/data/workspace'

/** Simple structured logger; Home Assistant captures stdout/stderr. */
function log(level, message) {
  process.stdout.write(`${new Date().toISOString()} [entrypoint] ${level} ${message}\n`)
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

/** @param {Record<string, unknown>} options */
function exportOptions(options) {
  const mapping = [
    ['model', 'DSH_OPT_MODEL'],
    ['base_url', 'DSH_OPT_BASE_URL'],
    ['read_only', 'DSH_OPT_READ_ONLY'],
    ['allow_restarts', 'DSH_OPT_ALLOW_RESTARTS'],
    ['allow_addon_management', 'DSH_OPT_ALLOW_ADDON_MANAGEMENT'],
    ['monitor_enabled', 'DSH_OPT_MONITOR_ENABLED'],
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
    process.env.DEEPSEEK_BASE_URL = baseUrl.trim().replace(/\/+$/, '')
  }
  process.env.DSH_PERMISSION_MODE = options.read_only === true ? 'read-only' : 'workspace-write'
}

/** Create the persistent directory layout. */
async function ensureDirectories() {
  for (const directory of [
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

  await restoreManaged(MANAGED_AGENTS, join(DSH_HOME, 'AGENTS.md'))

  // Skills are served from the read-only image root via DSH_BUNDLED_SKILL_DIR,
  // so they cannot drift or be shadowed by files under /data.

  // Trim a stale token so the shim never injects a token from a previous boot.
  await rm(TOKEN_FILE, { force: true })

  const logStream = createWriteStream(LOG_FILE, { flags: 'a', mode: 0o600 })
  logStream.on('error', (error) => log('WARN', `log file unavailable: ${error.message}`))

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
        DSH_ADDON_VERSION: process.env.DSH_ADDON_VERSION ?? '0.1.0',
        HOME: '/data',
      },
      onLine: (line) => {
        logStream.write(`${new Date().toISOString()} [dsh] ${line}\n`)
        void captureToken(line)
      },
    },
  )
  children.set('dsh', web)

  const shim = startChild('shim', process.execPath, [SHIM], {
    env: {
      DSH_WEB_PORT: String(WEB_PORT),
      DSH_INGRESS_PORT: String(INGRESS_PORT),
      DSH_TOKEN_FILE: TOKEN_FILE,
    },
  })
  children.set('shim', shim)

  const collector = startChild('collector', process.execPath, [COLLECTOR], {
    env: { DSH_HOME },
  })
  children.set('collector', collector)

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
    `DeepSeek Harness starting: web=127.0.0.1:${WEB_PORT}, ingress=0.0.0.0:${INGRESS_PORT}, read_only=${
      options.read_only === true
    }, monitor=${options.monitor_enabled !== false}`,
  )
  logStream.write(`${new Date().toISOString()} [entrypoint] started\n`)
}

if (!existsSync('/opt/ha-dsh')) {
  log('WARN', 'expected image tree /opt/ha-dsh is missing; running from a non-add-on environment')
}

await main()

