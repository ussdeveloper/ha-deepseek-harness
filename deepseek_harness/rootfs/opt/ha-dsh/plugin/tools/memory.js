/**
 * Memory tools: read, refresh and curate the persistent agent memory.
 *
 * Tool definitions only — `plugin/index.js` registers them after applying the
 * read-only filter and stripping `xClass`.
 *
 * @module plugin/tools/memory
 */

import { ok, toErrorResult, renderJson } from '../../lib/result.js'
import { classify } from '../../lib/safety.js'
import {
  CURATED_MAX_BYTES,
  CURATED_MAX_ENTRIES,
  collectSystem,
  readMemory,
  refreshCollected,
  updateMemory,
} from '../../lib/memory-store.js'

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

const OPS = ['set', 'append', 'add_quirk', 'resolve_quirk', 'record_change', 'record_backup']

export const tools = [
  tool(
    'memory_get',
    'Read the persistent memory about this Home Assistant installation: the deterministic collected inventory, the curated notes (preferences, hardware, quirks, intent, do-not-touch, open tasks) and recent changes. Skills call this early to avoid re-asking known facts. Returns `stale[]` sections that should be refreshed.',
    {
      sections: {
        type: 'array',
        items: { type: 'string', enum: ['collected', 'curated', 'summary', 'changelog', 'backups'] },
        description: 'Optional subset of sections; omit for the whole memory.',
      },
      fresh: {
        type: 'boolean',
        description: 'Skip the age-based staleness warning for collected data.',
      },
      include_changelog: {
        type: 'boolean',
        description: 'Set false to omit the changelog tail and backup ledger (fewer tokens).',
      },
    },
    [],
    async (args) => {
      const result = await readMemory({
        sections: args.sections,
        fresh: args.fresh === true,
        changelog_limit: args.include_changelog === false ? 0 : 20,
        backups_limit: args.include_changelog === false ? 0 : 20,
      })
      const entries = result.summary?.curated_entries
      const summary = `Memory revision ${result.revision}${entries === undefined ? '' : `; ${entries} curated entr${entries === 1 ? 'y' : 'ies'}`}${result.stale.length > 0 ? `; stale: ${result.stale.join(', ')}` : ''}.`
      return ok(summary, result)
    },
  ),
  tool(
    'memory_refresh',
    'Re-run deterministic collection (read-only HA/Supervisor calls, no model calls) and store the collected inventory in /data/memory. Use after updates, restores or config changes. Returns a diff summary so unchanged refreshes are cheap.',
    {
      sections: {
        type: 'array',
        items: { type: 'string' },
        description: 'Optional subset of collected sections (versions, host, system, integrations, entities, automations, apps, updates, backups).',
      },
    },
    [],
    async (args) => {
      const result = await refreshCollected(() => collectSystem({ sections: args.sections }))
      const changed = result.diff.changed_sections
      const summary = result.changed
        ? `Collected inventory refreshed (revision ${result.revision}); changed: ${changed.join(', ') || 'revision only'}.`
        : `Collected inventory unchanged (revision ${result.revision}).`
      const warnings = Array.isArray(result.errors) && result.errors.length > 0
        ? result.errors.map((error) => ({ code: 'UPSTREAM_ERROR', message: `${error.section}: ${error.message}` }))
        : []
      return ok(summary, result, { source: result.source, warnings })
    },
  ),
  tool(
    'memory_update',
    'Curate persistent memory: record preferences, hardware facts, quirks, the intent behind automations, do-not-touch targets, open tasks, durable changes and backup ledger entries. Curated memory is bounded and revision-checked (pass base_revision from memory_get for optimistic concurrency). Collected data can never be edited here.',
    {
      ops: {
        type: 'array',
        minItems: 1,
        maxItems: 50,
        items: {
          type: 'object',
          properties: {
            op: { type: 'string', enum: OPS },
            key: { type: 'string', description: 'Bucket name or dotted "bucket.subkey" (e.g. "preferences", "intent.automation.porch_lights").' },
            value: { description: 'New value for set (array for list buckets, object for intent/backup_policy).' },
            text: { type: 'string', description: 'Text for append/add_quirk.' },
            id: { type: 'string', description: 'Quirk id for resolve_quirk (q_…).' },
            entry: { type: 'object', additionalProperties: true, description: 'Entry for record_change / record_backup.' },
          },
          required: ['op'],
          additionalProperties: false,
        },
      },
      reason: { type: 'string', description: 'One-line reason recorded in changelog.jsonl.' },
      base_revision: { type: 'integer', description: 'Revision from memory_get for optimistic concurrency (CONFLICT when stale).' },
    },
    ['ops'],
    async (args) => {
      const result = await updateMemory({
        ops: args.ops,
        reason: args.reason,
        base_revision: args.base_revision,
      })
      return ok(
        `Memory updated to revision ${result.revision} (${result.changed.length} change${result.changed.length === 1 ? '' : 's'}; ${result.curated_bytes}/${CURATED_MAX_BYTES} bytes, ${result.entries}/${CURATED_MAX_ENTRIES} entries).`,
        result,
      )
    },
  ),
]

export default tools
