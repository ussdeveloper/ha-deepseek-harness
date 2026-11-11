/**
 * One-shot Home Assistant WebSocket client.
 *
 * Some diagnostics (registry lists, repairs, structured system log, automation
 * traces) are only exposed over Home Assistant's WebSocket API, not the
 * documented REST surface. Home Assistant documents the framing
 * (`auth_required` → `auth` → `auth_ok`, then `{id, type, ...}` →
 * `{id, type: 'result', success, result|error}`); the individual interaction
 * commands are frontend-only and therefore a compatibility risk. Every caller
 * must treat `UNSUPPORTED` as a normal answer and point the user at the UI.
 *
 * v1 keeps one short-lived connection per call: simple and robust, and a
 * diagnostic call runs at most once per model turn.
 *
 * @module ha-ws
 */

import { getPaths } from './paths.js'
import { ToolError } from './result.js'

/** Default timeout for connect + auth + one command, in milliseconds. */
export const DEFAULT_WS_TIMEOUT_MS = 15_000

/** Monotonic command id shared by all short-lived connections. */
let nextId = 1

/**
 * Derive the Home Assistant WebSocket proxy URL from the Supervisor base URL:
 * `http://supervisor` → `ws://supervisor/core/websocket`.
 * @param {string} [base] Supervisor base URL (defaults to `DSH_SUPERVISOR_URL`)
 * @returns {string}
 */
export function deriveWsUrl(base = getPaths().supervisorUrl) {
  const value = String(base ?? '').replace(/\/+$/, '')
  if (value === '') throw new ToolError('INVALID_ARGUMENT', 'The Supervisor URL is empty.')
  if (value.startsWith('ws://') || value.startsWith('wss://')) return `${value}/core/websocket`
  if (value.startsWith('https://')) return `wss://${value.slice('https://'.length)}/core/websocket`
  if (value.startsWith('http://')) return `ws://${value.slice('http://'.length)}/core/websocket`
  throw new ToolError('INVALID_ARGUMENT', `Unsupported Supervisor URL scheme: ${value}`, {
    hint: 'DSH_SUPERVISOR_URL must be an http(s):// URL such as http://supervisor.',
  })
}

/**
 * @param {string} type Home Assistant WebSocket command type, e.g. `config/entity_registry/list`
 * @param {Record<string, unknown>} [payload] extra command fields
 * @param {{ timeoutMs?: number, token?: string, url?: string }} [options]
 * @returns {Promise<unknown>} the `result` payload of a successful command
 */
export async function haWs(type, payload = undefined, options = {}) {
  const token = options.token ?? process.env.SUPERVISOR_TOKEN
  if (token === undefined || token === '') {
    throw new ToolError(
      'FORBIDDEN',
      'SUPERVISOR_TOKEN is not set: the plugin is not running inside a Home Assistant add-on.',
      { hint: 'Start the add-on from Home Assistant; direct container runs cannot use HA WebSocket diagnostics.' },
    )
  }
  const timeoutMs = options.timeoutMs ?? DEFAULT_WS_TIMEOUT_MS
  const url = options.url ?? deriveWsUrl()

  if (typeof globalThis.WebSocket !== 'function') {
    throw new ToolError('UNSUPPORTED', 'This Node.js runtime has no global WebSocket client.', {
      hint: 'Node 24 is required for WebSocket-backed diagnostics.',
    })
  }

  /** @type {WebSocket} */
  let socket
  try {
    socket = new globalThis.WebSocket(url)
  } catch (error) {
    throw new ToolError('UPSTREAM_ERROR', `Could not open the Home Assistant WebSocket: ${errorMessage(error)}`, {
      hint: 'Check that the add-on has homeassistant_api enabled and that Home Assistant is running.',
      retryable: true,
    })
  }

  const id = nextId++

  return await new Promise((resolve, reject) => {
    let settled = false
    /** @param {Error} [error] @param {unknown} [value] */
    const finish = (error, value) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      try {
        socket.close()
      } catch {
        /* already closed */
      }
      if (error !== undefined && error !== null) reject(error)
      else resolve(value)
    }
    const timer = setTimeout(() => {
      finish(
        new ToolError('UPSTREAM_ERROR', `Home Assistant WebSocket command "${type}" timed out after ${timeoutMs} ms.`, {
          hint: 'Home Assistant may be busy or restarting; retry once it is healthy.',
          retryable: true,
        }),
      )
    }, timeoutMs)

    socket.addEventListener('message', (event) => {
      const message = parseMessage(event?.data)
      if (message === null) {
        finish(
          new ToolError('UPSTREAM_ERROR', 'Home Assistant sent an unparseable WebSocket message.', {
            retryable: true,
          }),
        )
        return
      }
      if (message.type === 'auth_required') {
        socket.send(JSON.stringify({ type: 'auth', access_token: token }))
        return
      }
      if (message.type === 'auth_invalid') {
        finish(
          new ToolError('FORBIDDEN', 'Home Assistant rejected the add-on token for the WebSocket API.', {
            hint: 'Check the add-on permissions (homeassistant_api: true) and restart the add-on.',
          }),
        )
        return
      }
      if (message.type === 'auth_ok') {
        socket.send(JSON.stringify({ id, type, ...(payload ?? {}) }))
        return
      }
      if (message.type === 'result' && message.id === id) {
        if (message.success === true) {
          finish(undefined, message.result)
          return
        }
        finish(wsCommandError(type, message.error))
      }
    })

    socket.addEventListener('error', () => {
      finish(
        new ToolError('UPSTREAM_ERROR', 'The Home Assistant WebSocket connection failed.', {
          hint: 'Check that Home Assistant is running and reachable at ws://supervisor/core/websocket.',
          retryable: true,
        }),
      )
    })

    socket.addEventListener('close', () => {
      finish(
        new ToolError('UPSTREAM_ERROR', `The Home Assistant WebSocket closed before "${type}" answered.`, {
          retryable: true,
        }),
      )
    })
  })
}

/**
 * Map a Home Assistant WebSocket error frame to a ToolError. Unknown command
 * types are the expected failure mode for frontend-only diagnostics, so they
 * become a friendly `UNSUPPORTED` instead of an upstream error.
 * @param {string} type
 * @param {{ code?: string, message?: string }} [error]
 * @returns {ToolError}
 */
function wsCommandError(type, error) {
  const code = typeof error?.code === 'string' ? error.code : 'unknown_error'
  const message = typeof error?.message === 'string' && error.message !== '' ? error.message : 'no message'
  if (code === 'unknown_command' || code === 'unknown_command_type') {
    return new ToolError(
      'UNSUPPORTED',
      `This Home Assistant version does not support the WebSocket command "${type}" (${message}).`,
      { hint: 'Use the Home Assistant UI instead; the command names are frontend-only and may change between releases.' },
    )
  }
  if (code === 'unauthorized' || code === 'auth_invalid') {
    return new ToolError('FORBIDDEN', `Home Assistant refused the WebSocket command "${type}": ${message}`)
  }
  if (code === 'not_found') {
    return new ToolError('NOT_FOUND', `Home Assistant could not find the target of "${type}": ${message}`)
  }
  if (code === 'invalid_format') {
    return new ToolError('INVALID_ARGUMENT', `Home Assistant rejected the arguments of "${type}": ${message}`)
  }
  return new ToolError('UPSTREAM_ERROR', `Home Assistant WebSocket command "${type}" failed (${code}): ${message}`, {
    retryable: true,
  })
}

/** @param {unknown} data @returns {{type: string, [key: string]: unknown}|null} */
function parseMessage(data) {
  if (typeof data !== 'string') return null
  try {
    const parsed = JSON.parse(data)
    return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null
  } catch {
    return null
  }
}

/** @param {unknown} error @returns {string} */
function errorMessage(error) {
  return error instanceof Error ? error.message : String(error)
}
