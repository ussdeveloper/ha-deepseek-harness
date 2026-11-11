/**
 * Supervisor REST client used by every tool and by the background collector.
 *
 * The token comes from the add-on runtime (`SUPERVISOR_TOKEN`); it is never
 * logged, never returned to the model and never written to disk. Network and
 * timeout failures throw {@link ToolError}; HTTP error statuses are returned to
 * the caller as `{ ok: false, status, data }` so a tool can map them.
 *
 * @module supervisor
 */

import { getPaths } from './paths.js'
import { ToolError } from './result.js'

/** Default per-request timeout in milliseconds. */
export const DEFAULT_TIMEOUT_MS = 20_000

/**
 * @typedef {{ ok: boolean, status: number, data: unknown }} ApiResponse
 */

/**
 * Call one Supervisor API path.
 * @param {string} path absolute path starting with `/`, e.g. `/addons`
 * @param {'GET'|'POST'|'PUT'|'DELETE'} [method]
 * @param {unknown} [body] JSON body for POST/PUT
 * @param {{ timeoutMs?: number, signal?: AbortSignal, token?: string }} [options]
 * @returns {Promise<ApiResponse>}
 */
export async function sup(path, method = 'GET', body = undefined, options = {}) {
  const token = options.token ?? process.env.SUPERVISOR_TOKEN
  if (token === undefined || token === '') {
    throw new ToolError(
      'FORBIDDEN',
      'SUPERVISOR_TOKEN is not set: the plugin is not running inside a Home Assistant add-on.',
      { hint: 'Start the add-on from Home Assistant; direct container runs cannot use Supervisor tools.' },
    )
  }
  if (!path.startsWith('/')) throw new ToolError('INVALID_ARGUMENT', `Supervisor path must start with "/": ${path}`)

  const base = getPaths().supervisorUrl
  const timeout = AbortSignal.timeout(options.timeoutMs ?? DEFAULT_TIMEOUT_MS)
  const signal = options.signal === undefined ? timeout : AbortSignal.any([options.signal, timeout])

  let response
  try {
    response = await fetch(`${base}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${token}`,
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal,
    })
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error)
    throw new ToolError('UPSTREAM_ERROR', `Supervisor request failed: ${method} ${path}: ${reason}`, {
      hint: 'Check that the Supervisor is healthy and retry.',
      retryable: true,
    })
  }

  const text = await response.text()
  let data
  try {
    data = text === '' ? null : JSON.parse(text)
  } catch {
    data = text
  }
  return { ok: response.ok, status: response.status, data }
}

/**
 * Call a Supervisor path and throw when the HTTP status is not acceptable.
 * @param {string} path
 * @param {'GET'|'POST'|'PUT'|'DELETE'} [method]
 * @param {unknown} [body]
 * @param {{ timeoutMs?: number, signal?: AbortSignal, expect?: number[] }} [options]
 * @returns {Promise<unknown>} parsed response body
 */
export async function supOk(path, method = 'GET', body = undefined, options = {}) {
  const response = await sup(path, method, body, options)
  const expect = options.expect ?? [200, 201, 202]
  if (!response.ok) {
    const message =
      typeof response.data === 'object' && response.data !== null && 'message' in response.data
        ? String(response.data.message)
        : `Supervisor returned HTTP ${response.status}`
    throw new ToolError('UPSTREAM_ERROR', message, {
      hint: `Supervisor path ${method} ${path} failed; read /supervisor/logs for details.`,
      retryable: response.status >= 500,
    })
  }
  return response.data
}

/**
 * Poll one Supervisor job until it finishes.
 * @param {string} jobId
 * @param {{ timeoutMs?: number, intervalMs?: number, signal?: AbortSignal }} [options]
 * @returns {Promise<{ done: boolean, progress: number, stage: string, errors: unknown[], data: unknown }>}
 */
export async function waitForJob(jobId, options = {}) {
  const timeoutMs = options.timeoutMs ?? 120_000
  const intervalMs = options.intervalMs ?? 1_500
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const job = await supOk(`/jobs/${encodeURIComponent(jobId)}`, 'GET', undefined, {
      ...(options.signal === undefined ? {} : { signal: options.signal }),
      timeoutMs: Math.min(20_000, Math.max(1_000, deadline - Date.now())),
    })
    const record = job && typeof job === 'object' ? job : {}
    if (record.done === true) {
      return {
        done: true,
        progress: Number(record.progress ?? 100),
        stage: String(record.stage ?? 'done'),
        errors: Array.isArray(record.errors) ? record.errors : [],
        data: job,
      }
    }
    if (Date.now() >= deadline) {
      throw new ToolError('UPSTREAM_ERROR', `Supervisor job ${jobId} did not finish within ${timeoutMs} ms.`, {
        hint: 'Read the job with sup_job_status, or check /supervisor/logs.',
        retryable: true,
      })
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs))
  }
}
