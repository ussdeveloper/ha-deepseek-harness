/**
 * Notification tool: deliver a user-facing message through Home Assistant.
 *
 * Tool definitions only — `plugin/index.js` registers them after applying the
 * read-only filter and stripping `xClass`.
 *
 * @module plugin/tools/notify
 */

import { ok, toErrorResult, renderJson } from '../../lib/result.js'
import { classify } from '../../lib/safety.js'
import { notifyUser } from '../../lib/notify.js'

const OUTPUT = Object.freeze({
  schema: { type: 'object', additionalProperties: true },
  render: renderJson,
})

/**
 * @param {string} name
 * @param {string} description
 * @param {object} properties
 * @param {string[]} required
 * @param {(args: object) => Promise<object>} execute
 * @returns {object}
 */
function tool(name, description, properties, required, execute) {
  return {
    name,
    description,
    parameters: {
      type: 'object',
      properties,
      ...(required.length === 0 ? {} : { required }),
      additionalProperties: false,
    },
    output: OUTPUT,
    xClass: classify(name),
    async execute(args = {}) {
      try {
        return await execute(args ?? {})
      } catch (error) {
        return toErrorResult(error)
      }
    },
  }
}

export const tools = [
  tool(
    'notify_user',
    'Send a user-facing notification through Home Assistant: a persistent notification always, plus the configured notify service when set. Quiet hours suppress severity < 3; a dedupe_key throttles repeats inside an hour. Use it for important findings, finished long tasks or questions that need attention — not for chatty progress updates.',
    {
      title: { type: 'string', description: 'Short title (≤120 chars).' },
      message: { type: 'string', description: 'Plain-language message; no tokens, secrets or raw JSON.' },
      severity: { type: 'integer', minimum: 0, maximum: 4, description: '0 info, 1 info, 2 warning, 3 serious, 4 critical (default 2).' },
      dedupe_key: { type: 'string', description: 'Stable key for the same notification so repeats are throttled.' },
      notify_service: { type: 'string', description: 'Override the configured notify service, e.g. notify.mobile_app_pixel.' },
      quiet_hours: { type: 'string', description: 'Override quiet hours "HH:MM-HH:MM" (default from add-on options).' },
      force: { type: 'boolean', description: 'Bypass quiet hours and throttling (use sparingly).' },
    },
    ['message'],
    async (args) => {
      const result = await notifyUser({
        title: args.title,
        message: args.message,
        severity: args.severity,
        dedupe_key: args.dedupe_key,
        notify_service: args.notify_service,
        quiet_hours: args.quiet_hours,
        force: args.force === true,
      })
      const warnings = result.errors.map((error) => ({ code: 'UPSTREAM_ERROR', message: `${error.channel}: ${error.message}` }))
      if (result.delivered.length === 0) {
        const reason = result.suppressed.join(', ') || 'no channel available'
        return ok(`Notification suppressed (${reason}).`, result, { warnings })
      }
      return ok(`Notification delivered via ${result.delivered.join(', ')}.`, result, { warnings })
    },
  ),
]

export default tools
