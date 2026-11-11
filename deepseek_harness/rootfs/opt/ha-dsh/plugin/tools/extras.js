/**
 * Extended knowledge/dashboard tools referenced by the skills but not part of
 * the core HA/Supervisor surface.
 *
 * These tools are read-mostly and deterministic: the compatibility scan and the
 * recommendation assistant work from memory + the local knowledge cache and
 * make zero LLM calls of their own. Dashboard reads/writes use undocumented
 * frontend WebSocket commands, so they degrade to UNSUPPORTED with a UI pointer
 * when the installed Home Assistant version does not support them.
 *
 * @module tools/extras
 */

import { haWs } from '../../lib/ha-ws.js'
import { readMemory } from '../../lib/memory-store.js'
import { readIndex, search } from '../../lib/knowledge-store.js'
import { consumeApproval, needsApproval } from '../../lib/safety.js'
import { ok, fail, toErrorResult, renderJson } from '../../lib/result.js'

const output = { schema: { type: 'object', additionalProperties: true }, render: renderJson }

/** @param {string} text @returns {string[]} lowercase search tokens */
function tokens(text) {
  return String(text ?? '')
    .toLowerCase()
    .split(/[^a-z0-9\u00c0-\u024f]+/)
    .filter((token) => token.length >= 3)
}

/** @param {unknown} value @returns {string} */
function text(value) {
  return typeof value === 'string' ? value : ''
}

/** @type {object[]} */
export const tools = [
  {
    name: 'ha_get_dashboard',
    description:
      'Read a Lovelace dashboard configuration (storage mode). Uses an undocumented frontend WebSocket command; returns UNSUPPORTED with the UI path when unavailable.',
    parameters: {
      type: 'object',
      properties: {
        url_path: { type: 'string', description: 'Dashboard url_path; "lovelace" is the default dashboard' },
      },
      additionalProperties: false,
    },
    output,
    xClass: 'R',
    async execute(args) {
      const urlPath = text(args?.url_path) || 'lovelace'
      try {
        const config = await haWs('lovelace/config', { url_path: urlPath }, { timeoutMs: 20_000 })
        return ok(`Read dashboard "${urlPath}".`, { url_path: urlPath, config }, { source: ['WS lovelace/config'] })
      } catch (error) {
        const result = toErrorResult(error, ['WS lovelace/config'])
        if (result.ok === false && result.error.code === 'UNSUPPORTED') {
          result.error.hint = 'Open Settings → Dashboards in the Home Assistant UI to inspect or edit this dashboard.'
        }
        return result
      }
    },
  },

  {
    name: 'ha_save_dashboard',
    description:
      'Overwrite a storage-mode Lovelace dashboard configuration. Requires a confirmation token and is disabled in read-only mode.',
    parameters: {
      type: 'object',
      properties: {
        url_path: { type: 'string', description: 'Dashboard url_path; "lovelace" is the default dashboard' },
        config: { type: 'object', additionalProperties: true, description: 'Complete dashboard configuration object' },
        confirmation_token: { type: 'string', description: 'Token returned by a previous call without one' },
      },
      required: ['config'],
      additionalProperties: false,
    },
    output,
    xClass: 'SW',
    async execute(args) {
      const urlPath = text(args?.url_path) || 'lovelace'
      if (typeof args?.confirmation_token !== 'string') {
        return needsApproval('ha_save_dashboard', args ?? {}, {
          action: `Overwrite the Lovelace dashboard "${urlPath}"`,
          impact: 'The current dashboard configuration is replaced. Other users see the change immediately.',
          rollback: 'The previous configuration is not kept by this tool; export the dashboard first.',
        })
      }
      try {
        consumeApproval('ha_save_dashboard', args ?? {})
        await haWs('lovelace/config/save', { url_path: urlPath, config: args.config }, { timeoutMs: 20_000 })
        return ok(`Saved dashboard "${urlPath}".`, { url_path: urlPath }, { source: ['WS lovelace/config/save'] })
      } catch (error) {
        return toErrorResult(error, ['WS lovelace/config/save'])
      }
    },
  },

  {
    name: 'ha_compat_scan',
    description:
      'Deterministically compare the installed Home Assistant versions/components with locally cached breaking changes and deprecations. Zero LLM calls; may return stale knowledge with its fetch dates.',
    parameters: {
      type: 'object',
      properties: {
        target: {
          type: 'string',
          description: 'What to scan for: "upcoming" (default), or an integration domain to focus on',
        },
      },
      additionalProperties: false,
    },
    output,
    xClass: 'R',
    async execute(args) {
      try {
        const memory = await readMemory({ max_age_hours: 72 })
        const collected = memory.memory.collected ?? {}
        const versions = collected.versions ?? {}
        const components = Array.isArray(collected.integrations?.components)
          ? collected.integrations.components.map(String)
          : []
        const focus = text(args?.target).toLowerCase()
        const index = await readIndex()
        const items = Array.isArray(index.items) ? index.items : []
        const breaking = items.filter((item) => {
          const haystack = `${item.title ?? ''} ${item.excerpt ?? ''} ${item.tags ?? ''}`.toLowerCase()
          return haystack.includes('breaking change') || haystack.includes('deprecat')
        })
        const findings = []
        for (const item of breaking.slice(0, 40)) {
          const haystack = `${item.title ?? ''} ${item.excerpt ?? ''}`.toLowerCase()
          const affected = components.filter((component) => tokens(component).some((token) => haystack.includes(token)))
          if (focus !== '' && focus !== 'upcoming' && !haystack.includes(focus)) continue
          findings.push({
            severity: affected.length > 0 ? 'warning' : 'info',
            title: item.title ?? 'Breaking change',
            evidence_url: item.url ?? null,
            published_at: item.published_at ?? null,
            fetched_at: item.fetched_at ?? null,
            affects_installed: affected.slice(0, 10),
          })
        }
        return ok(
          `${findings.length} compatibility note(s); knowledge cache updated ${index.updated_at ?? 'never'}.`,
          {
            versions,
            installed_components: components.length,
            knowledge_updated_at: index.updated_at ?? null,
            stale: breaking.length === 0 || index.items === undefined,
            findings,
          },
          { source: ['memory system.json', 'knowledge index.json'] },
        )
      } catch (error) {
        return toErrorResult(error, ['memory system.json', 'knowledge index.json'])
      }
    },
  },

  {
    name: 'ha_recommend',
    description:
      'Retrieve and score fitting Home Assistant functionality from the LOCAL knowledge cache and store catalog. Deterministic retrieval plus a transparent fit/effort/risk/maintenance score; never installs anything.',
    parameters: {
      type: 'object',
      properties: {
        need: { type: 'string', description: 'What the user wants to achieve, in their own words' },
        k: { type: 'number', description: 'Number of options to return (1-5, default 3)' },
      },
      required: ['need'],
      additionalProperties: false,
    },
    output,
    xClass: 'R',
    async execute(args) {
      try {
        const need = text(args?.need)
        if (need.trim() === '') {
          return fail('INVALID_ARGUMENT', 'Describe the need you want recommendations for.', {
            hint: 'Example: "cheap Zigbee presence sensor for the hallway".',
          })
        }
        const k = Math.min(5, Math.max(1, Number.isFinite(Number(args?.k)) ? Math.trunc(Number(args.k)) : 3))
        const hits = await search({ query: need, k, max_excerpt: 500 })
        const options = (hits.results ?? []).map((hit, index) => ({
          rank: index + 1,
          name: hit.title ?? 'Untitled',
          url: hit.url ?? null,
          source: hit.source ?? 'knowledge',
          published_at: hit.published_at ?? null,
          excerpt: hit.excerpt ?? '',
          score: hit.score ?? null,
          tradeoffs: {
            fit: index === 0 ? 'strong' : 'possible',
            effort: 'unknown from the cache — verify before proposing an install',
            risk: 'community sources need review; prefer official integrations first',
            maintenance: 'check last release/archived status before recommending',
          },
        }))
        return ok(`Found ${options.length} candidate(s) in the local knowledge cache.`, {
          need,
          knowledge_updated_at: hits.index_updated_at ?? null,
          options,
          note: 'Retrieval only: verify each candidate against the live store/integration docs and let the user decide. Nothing was installed.',
        })
      } catch (error) {
        return toErrorResult(error, ['knowledge index.json'])
      }
    },
  },
]

export default tools

/** Keep the import used by tooling from being tree-shaken away. */
void readIndex
