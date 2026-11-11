/**
 * Home Assistant Core REST client over the Supervisor proxy.
 *
 * `homeassistant_api: true` makes `/core/api/*` behave like an authenticated
 * HA administrator session; the plugin still enforces the read-only option and
 * the deny-lists in `lib/safety.js`.
 *
 * @module ha-core
 */

import { sup } from './supervisor.js'

/** @typedef {{ ok: boolean, status: number, data: unknown }} ApiResponse */

/**
 * Call one Home Assistant Core REST path (without the `/core/api` prefix).
 * @param {string} path e.g. `/states`
 * @param {'GET'|'POST'|'PUT'|'DELETE'} [method]
 * @param {unknown} [body]
 * @param {{ timeoutMs?: number, signal?: AbortSignal }} [options]
 * @returns {Promise<ApiResponse>}
 */
export function ha(path, method = 'GET', body = undefined, options = {}) {
  return sup(`/core/api${path}`, method, body, options)
}

/**
 * Call a Core path, throwing on a non-2xx status.
 * @param {string} path
 * @param {'GET'|'POST'|'PUT'|'DELETE'} [method]
 * @param {unknown} [body]
 * @param {{ timeoutMs?: number, signal?: AbortSignal, expect?: number[] }} [options]
 * @returns {Promise<unknown>}
 */
export async function haOk(path, method = 'GET', body = undefined, options = {}) {
  const { supOk } = await import('./supervisor.js')
  return supOk(`/core/api${path}`, method, body, options)
}

/** @returns {Promise<unknown>} `GET /api/config` */
export function getConfig(options) {
  return haOk('/config', 'GET', undefined, options)
}

/** @returns {Promise<unknown[]>} `GET /api/states` */
export function getStates(options) {
  return haOk('/states', 'GET', undefined, options)
}

/** @param {string} entityId @returns {Promise<unknown>} */
export function getState(entityId, options) {
  return haOk(`/states/${encodeURIComponent(entityId)}`, 'GET', undefined, options)
}

/** @returns {Promise<unknown>} `GET /api/services` */
export function getServices(options) {
  return haOk('/services', 'GET', undefined, options)
}

/**
 * Render a template server-side (read-only in effect but an admin endpoint).
 * @param {string} template
 * @param {Record<string, unknown>} [variables]
 * @returns {Promise<{ rendered: string|null, error?: string }>}
 */
export function renderTemplate(template, variables) {
  return haOk('/template', 'POST', { template, ...(variables === undefined ? {} : { variables }) })
}

/** @returns {Promise<{ result: string, errors?: string|null, warnings?: string[] }>} */
export function checkConfig(options) {
  return haOk('/config/core/check_config', 'POST', undefined, options)
}

/** @returns {Promise<string>} raw text of `/api/error_log` */
export async function errorLog(options) {
  const response = await ha('/error_log', 'GET', undefined, options)
  return typeof response.data === 'string' ? response.data : JSON.stringify(response.data)
}

/**
 * Call one service.
 * @param {string} domain
 * @param {string} service
 * @param {unknown} [data]
 * @param {{ returnResponse?: boolean }} [options]
 */
export function callService(domain, service, data, options = {}) {
  const query = options.returnResponse === true ? '?return_response' : ''
  return haOk(`/services/${encodeURIComponent(domain)}/${encodeURIComponent(service)}${query}`, 'POST', data ?? {})
}

/** @returns {Promise<unknown>} `GET /api/history/period` */
export function history(pathQuery, options) {
  return haOk(`/history/period${pathQuery}`, 'GET', undefined, options)
}

/** @returns {Promise<unknown>} `GET /api/logbook` */
export function logbook(pathQuery, options) {
  return haOk(`/logbook${pathQuery}`, 'GET', undefined, options)
}
