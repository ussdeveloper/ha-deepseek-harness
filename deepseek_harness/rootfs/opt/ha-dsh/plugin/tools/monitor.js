/**
 * Monitoring tools: probe, digest, history and configuration.
 *
 * Tool definitions only — `plugin/index.js` registers them after applying the
 * read-only filter and stripping `xClass`.
 *
 * @module plugin/tools/monitor
 */

import { fail, ok, toErrorResult, renderJson } from '../../lib/result.js'
import { classify, readOnly } from '../../lib/safety.js'
import { configure, digest, history, probe, readMonitorConfig } from '../../lib/monitor-store.js'

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
    'monitor_probe',
    'Run a read-only health probe over Home Assistant and the Supervisor (core reachability, unavailable entities and their trend, backups, updates, app health, disk, and in deep mode the error log and Supervisor resolution). Findings are deduplicated with a 6 h cooldown. Set notify=true to send notifications for severity ≥ 2 outside quiet hours; it never changes Home Assistant state.',
    {
      deep: {
        type: 'boolean',
        description: 'Also scan the error log and Supervisor resolution info (more requests, slower).',
      },
      notify: {
        type: 'boolean',
        description: 'Send a notification for new/escalated severity ≥ 2 findings (default false).',
      },
    },
    [],
    async (args) => {
      const config = await readMonitorConfig()
      if (!config.enabled) {
        return ok('Monitoring is disabled in the monitor configuration.', {
          enabled: false,
          skipped_reason: 'monitor_disabled',
        })
      }
      if (args.notify === true && readOnly()) {
        return fail('FORBIDDEN', 'Sending notifications is disabled in read-only mode.', {
          hint: 'Run the probe with notify=false, or turn off the read_only add-on option.',
        })
      }
      const result = await probe({ deep: args.deep === true, notify: args.notify === true })
      const summary = result.max_severity === 0
        ? `Probe clean: ${result.signals.length} signal(s) checked, no findings.`
        : `Probe found ${result.findings.length} finding(s) (max severity ${result.max_severity})${result.notified.length > 0 ? `; notified ${result.notified.length}` : ''}.`
      return ok(summary, result, {
        source: result.source,
        warnings: result.errors.map((error) => ({ code: 'UPSTREAM_ERROR', message: `${error.check}: ${error.message}` })),
      })
    },
  ),
  tool(
    'monitor_digest',
    'Render the deterministic ≤20-line Markdown health digest for the last window (no model call). With send=true it is delivered through the configured notification channels (quiet hours apply); an all-clear digest is skipped unless an alert was sent in the previous 24 h.',
    {
      send: {
        type: 'boolean',
        description: 'Deliver the digest as a notification (default false: render only).',
      },
      window_h: {
        type: 'integer',
        minimum: 1,
        maximum: 168,
        description: 'Window in hours (default from monitor config, usually 24).',
      },
    },
    [],
    async (args) => {
      const alreadyDelivered = readOnly() && args.send === true
      if (alreadyDelivered) {
        return fail('FORBIDDEN', 'Sending the digest is disabled in read-only mode.', {
          hint: 'Call monitor_digest with send=false to render it.',
        })
      }
      const result = await digest({ send: args.send === true, window_h: args.window_h })
      const summary = result.sent
        ? `Digest sent via ${result.delivered.join(', ')} (${result.open_count} open finding(s)).`
        : result.skipped_reason === 'all_clear_no_recent_alert'
          ? 'Digest rendered; all clear, so it was not sent.'
          : `Digest rendered (${result.open_count} open finding(s)).`
      return ok(summary, result)
    },
  ),
  tool(
    'monitor_history',
    'Read recorded monitor findings from /data/monitor/findings.jsonl (newest first), filtered by time and severity.',
    {
      since: {
        type: ['string', 'number'],
        description: 'ISO timestamp or a number of hours back; omit for all recorded findings.',
      },
      severity_min: {
        type: 'integer',
        minimum: 0,
        maximum: 4,
        description: 'Minimum severity (0-4).',
      },
      limit: {
        type: 'integer',
        minimum: 1,
        maximum: 200,
        description: 'Maximum findings returned (default 50).',
      },
    },
    [],
    async (args) => {
      const result = await history({ since: args.since, severity_min: args.severity_min, limit: args.limit })
      return ok(`${result.count} finding(s) recorded.`, result)
    },
  ),
  tool(
    'monitor_configure',
    'Read or change the persistent monitor settings: enabled, quiet_hours, cooldown_hours, max_notifications_per_hour, digest_window_h, deep_interval_h, severity_min_notify and thresholds. Omit `patch` (or set get=true) to read.',
    {
      get: { type: 'boolean', description: 'Read the current configuration.' },
      patch: {
        type: 'object',
        additionalProperties: true,
        description: 'Settings to merge, e.g. {"quiet_hours":"22:00-07:00","cooldown_hours":6,"thresholds":{"unavailable_ratio_warn":0.1}}.',
      },
    },
    [],
    async (args) => {
      if (args.get === true || args.patch === undefined) {
        const result = await configure({})
        return ok('Monitor configuration read.', result)
      }
      const result = await configure({ patch: args.patch })
      return ok(`Monitor configuration updated (${(result.changed ?? []).join(', ') || 'no change'}).`, result)
    },
  ),
]

export default tools
