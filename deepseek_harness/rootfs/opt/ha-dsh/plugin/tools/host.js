/**
 * Host and Home Assistant OS tools.
 *
 * The add-on runs with `hassio_role: manager`, which the Supervisor documents as
 * sufficient for the host and OS endpoints (app protection mode and host SSH
 * keys are the admin-only exceptions we deliberately do not expose). Protection
 * mode does NOT need to be disabled for these calls: it only gates the
 * `full_access`, `docker_api` and `host_pid` grants.
 *
 * Reboot/shutdown/OS update are disruptive: they require the
 * `allow_host_management` option and the plugin's confirmation-token flow.
 *
 * @module tools/host
 */

import { spawn } from 'node:child_process'
import { sup, supOk } from '../../lib/supervisor.js'
import { consumeApproval, needsApproval } from '../../lib/safety.js'
import { ok, fail, toErrorResult, renderJson, truncate } from '../../lib/result.js'
import { getOptions } from '../../lib/paths.js'

const output = { schema: { type: 'object', additionalProperties: true }, render: renderJson }

/** @returns {boolean} */
export function canManageHost() {
  const options = getOptions()
  return options.readOnly !== true && options.allowHostManagement !== false
}

/** Wrap a read-only Supervisor GET with the canonical envelope. */
async function readJson(path, summary) {
  const response = await sup(path)
  if (!response.ok) {
    throw new Error(`Supervisor ${path} returned HTTP ${response.status}: ${typeof response.data === 'string' ? response.data : 'no body'}`)
  }
  return ok(summary, response.data, { source: [`GET ${path}`] })
}

/** Read a plain-text Supervisor response (host logs). */
async function readText(path, summary) {
  const response = await sup(path)
  const text = typeof response.data === 'string' ? response.data : JSON.stringify(response.data)
  const clipped = truncate(text, 12_000)
  return ok(summary, { text: clipped.text }, { source: [`GET ${path}`], truncated: clipped.truncated })
}

/** @type {object[]} */
export const tools = [
  {
    name: 'sup_host_info',
    description:
      'Read host and OS information: machine, disk use, kernel, time sync, host features, and the Home Assistant OS version/board/boot slot.',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    output,
    xClass: 'R',
    async execute() {
      try {
        const [host, os] = await Promise.all([sup('/host/info'), sup('/os/info')])
        const data = {
          host: host.ok ? host.data : { error: `HTTP ${host.status}` },
          os: os.ok ? os.data : { error: `HTTP ${os.status}`, note: 'OS endpoints exist only on Home Assistant OS.' },
        }
        return ok(`Host ${data.host?.operating_system ?? 'unknown'} / OS ${data.os?.version ?? 'n/a'}.`, data, {
          source: ['GET /host/info', 'GET /os/info'],
        })
      } catch (error) {
        return toErrorResult(error, ['GET /host/info', 'GET /os/info'])
      }
    },
  },
  {
    name: 'sup_host_services',
    description: 'List the host systemd services with their current state (read-only).',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    output,
    xClass: 'R',
    async execute() {
      try {
        const response = await sup('/host/services')
        if (!response.ok) throw new Error(`Supervisor returned HTTP ${response.status}`)
        const services = Array.isArray(response.data?.services) ? response.data.services : []
        return ok(`Read ${services.length} host service(s).`, { services }, { source: ['GET /host/services'] })
      } catch (error) {
        return toErrorResult(error, ['GET /host/services'])
      }
    },
  },
  {
    name: 'sup_host_logs',
    description:
      'Read the host systemd-journal logs (read-only), optionally for one syslog identifier such as NetworkManager, bluetoothd or audit.',
    parameters: {
      type: 'object',
      properties: {
        identifier: { type: 'string', description: 'Optional syslog identifier, e.g. NetworkManager' },
        lines: { type: 'number', description: 'Number of lines (default 200, max 1000)' },
      },
      additionalProperties: false,
    },
    output,
    xClass: 'R',
    async execute(args) {
      try {
        const lines = Math.max(2, Math.min(1000, Number.isFinite(Number(args?.lines)) ? Math.trunc(Number(args.lines)) : 200))
        const identifier = typeof args?.identifier === 'string' ? args.identifier.trim() : ''
        const path = identifier === '' ? `/host/logs?lines=${lines}` : `/host/logs/identifiers/${encodeURIComponent(identifier)}?lines=${lines}`
        return await readText(path, `Host logs (${identifier || 'default identifiers'}, ${lines} lines).`)
      } catch (error) {
        return toErrorResult(error, ['GET /host/logs'])
      }
    },
  },
  {
    name: 'sup_network_info',
    description: 'Read host network interfaces and the internal network configuration (read-only).',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    output,
    xClass: 'R',
    async execute() {
      try {
        return await readJson('/network/info', 'Host network configuration.')
      } catch (error) {
        return toErrorResult(error, ['GET /network/info'])
      }
    },
  },
  {
    name: 'sup_host_reboot',
    description:
      'Reboot the Home Assistant host. Disruptive: requires the allow_host_management option and a confirmation token; everything goes offline for a few minutes.',
    parameters: {
      type: 'object',
      properties: {
        force: { type: 'boolean', description: 'Reboot even during a database migration (default false)' },
        confirmation_token: { type: 'string' },
      },
      additionalProperties: false,
    },
    output,
    xClass: 'DIS',
    async execute(args) {
      if (!canManageHost()) {
        return fail('FORBIDDEN', 'Host management is disabled by the add-on options.', {
          hint: 'Ask the user to enable allow_host_management (and turn off read_only) in the add-on configuration.',
        })
      }
      const force = args?.force === true
      if (typeof args?.confirmation_token !== 'string') {
        return needsApproval('sup_host_reboot', args ?? {}, {
          action: 'Reboot the Home Assistant host',
          impact: 'Home Assistant, all apps and automations stop for several minutes; the UI is unavailable until the host is back.',
          rollback: 'None; the host boots again automatically. Running jobs and automations are interrupted.',
          backup: { available: false, suggestion: 'Create a full backup before rebooting if there are pending changes.' },
          facts: { force },
        })
      }
      try {
        consumeApproval('sup_host_reboot', args ?? {})
        await supOk('/host/reboot', 'POST', { force })
        return ok('Host reboot requested.', { force }, { source: ['POST /host/reboot'] })
      } catch (error) {
        return toErrorResult(error, ['POST /host/reboot'])
      }
    },
  },
  {
    name: 'sup_host_shutdown',
    description:
      'Shut the Home Assistant host down (power off). Destructive: requires allow_host_management and a confirmation token; the system stays offline until powered on manually.',
    parameters: {
      type: 'object',
      properties: {
        force: { type: 'boolean' },
        confirmation_token: { type: 'string' },
      },
      additionalProperties: false,
    },
    output,
    xClass: 'DES',
    async execute(args) {
      if (!canManageHost()) {
        return fail('FORBIDDEN', 'Host management is disabled by the add-on options.', {
          hint: 'Ask the user to enable allow_host_management in the add-on configuration.',
        })
      }
      const force = args?.force === true
      if (typeof args?.confirmation_token !== 'string') {
        return needsApproval('sup_host_shutdown', args ?? {}, {
          action: 'Shut down the Home Assistant host',
          impact: 'The whole system powers off. It will not come back until someone powers it on physically or via wake-on-LAN.',
          rollback: 'Manual power-on only.',
          backup: { available: false, suggestion: 'Create a full backup before shutting down.' },
          facts: { force },
        })
      }
      try {
        consumeApproval('sup_host_shutdown', args ?? {})
        await supOk('/host/shutdown', 'POST', { force })
        return ok('Host shutdown requested.', { force }, { source: ['POST /host/shutdown'] })
      } catch (error) {
        return toErrorResult(error, ['POST /host/shutdown'])
      }
    },
  },
  {
    name: 'sup_os_update',
    description:
      'Install the Home Assistant OS update (into the inactive slot; a reboot is still required). Disruptive: requires allow_host_management and a confirmation token.',
    parameters: {
      type: 'object',
      properties: {
        version: { type: 'string', description: 'Optional OS version; default is the latest available' },
        confirmation_token: { type: 'string' },
      },
      additionalProperties: false,
    },
    output,
    xClass: 'DIS',
    async execute(args) {
      if (!canManageHost()) {
        return fail('FORBIDDEN', 'Host management is disabled by the add-on options.', {
          hint: 'Ask the user to enable allow_host_management in the add-on configuration.',
        })
      }
      const body = typeof args?.version === 'string' && args.version.trim() !== '' ? { version: args.version.trim() } : {}
      if (typeof args?.confirmation_token !== 'string') {
        return needsApproval('sup_os_update', args ?? {}, {
          action: 'Install the Home Assistant OS update',
          impact: 'Downloads the OS update into the inactive boot slot. The running system is unchanged until the next reboot; updates can break integrations until rebooted.',
          rollback: 'Switch back to the previous boot slot on the next boot if the update fails.',
          backup: { available: false, suggestion: 'Create a full backup (including HA Core and apps) before updating the OS.' },
          facts: body,
        })
      }
      try {
        consumeApproval('sup_os_update', args ?? {})
        await supOk('/os/update', 'POST', body)
        return ok('OS update started; a reboot is required to apply it.', body, { source: ['POST /os/update'] })
      } catch (error) {
        return toErrorResult(error, ['POST /os/update'])
      }
    },
  },
  {
    name: 'sup_host_exec',
    description:
      'Run a shell command in the HOME ASSISTANT OS HOST namespace (nsenter via host_pid). Full host terminal: root filesystem, systemd, Docker, other apps. Destructive: requires allow_host_management and a confirmation token; output is bounded.',
    parameters: {
      type: 'object',
      properties: {
        command: { type: 'string', description: 'Shell command to run on the host (sh -lc)' },
        timeout_s: { type: 'number', description: 'Timeout in seconds (default 60, max 600)' },
        confirmation_token: { type: 'string' },
      },
      required: ['command'],
      additionalProperties: false,
    },
    output,
    xClass: 'DES',
    async execute(args) {
      if (!canManageHost()) {
        return fail('FORBIDDEN', 'Host management is disabled by the add-on options.', {
          hint: 'Ask the user to enable allow_host_management in the add-on configuration.',
        })
      }
      const command = typeof args?.command === 'string' ? args.command.trim() : ''
      if (command === '') return fail('INVALID_ARGUMENT', 'command is required.')
      const timeoutSeconds = Math.max(1, Math.min(600, Number.isFinite(Number(args?.timeout_s)) ? Math.trunc(Number(args.timeout_s)) : 60))
      if (typeof args?.confirmation_token !== 'string') {
        return needsApproval('sup_host_exec', args ?? {}, {
          action: 'Run a shell command in the Home Assistant host namespace',
          impact: `Command runs as root on the host: it can read/write every host file, control Docker, other apps and systemd. Output: ${truncate(command, 200).text}`,
          rollback: 'None automatic; the command may change or delete host data.',
          backup: { available: false, suggestion: 'Create a full backup before host-level changes.' },
          facts: { command: truncate(command, 500).text, timeout_s: timeoutSeconds },
        })
      }
      try {
        consumeApproval('sup_host_exec', args ?? {})
      } catch (error) {
        return toErrorResult(error, [])
      }
      return await new Promise((resolve) => {
        const child = spawn('nsenter', ['-t', '1', '-m', '-u', '-i', '-n', '-p', '--', 'sh', '-lc', command], {
          cwd: '/',
          env: process.env,
          stdio: ['ignore', 'pipe', 'pipe'],
        })
        let stdout = ''
        let stderr = ''
        let truncated = false
        const collect = (chunk, current, limit) => {
          const next = current + chunk.toString('utf8')
          if (next.length > limit) {
            truncated = true
            return next.slice(0, limit)
          }
          return next
        }
        child.stdout.on('data', (chunk) => { stdout = collect(chunk, stdout, 60_000) })
        child.stderr.on('data', (chunk) => { stderr = collect(chunk, stderr, 20_000) })
        const timer = setTimeout(() => {
          child.kill('SIGTERM')
          setTimeout(() => child.kill('SIGKILL'), 2_000)
        }, timeoutSeconds * 1_000)
        child.on('error', (error) => {
          clearTimeout(timer)
          resolve(fail('UNSUPPORTED', `Cannot start host shell: ${error.message}`, {
            hint: 'host_pid/full_access are only granted when protection mode is off. Restart the add-on after toggling protection mode.',
          }))
        })
        child.on('close', (code, signal) => {
          clearTimeout(timer)
          resolve(
            ok(
              code === 0 ? 'Host command finished.' : `Host command exited with code ${code ?? 'null'}${signal ? ` (${signal})` : ''}.`,
              { command, exit_code: code, signal, stdout, stderr, via: 'nsenter -t 1' },
              { source: ['nsenter -t 1 -m -u -i -n -p'], truncated },
            ),
          )
        })
      })
    },
  },
]

export default tools
