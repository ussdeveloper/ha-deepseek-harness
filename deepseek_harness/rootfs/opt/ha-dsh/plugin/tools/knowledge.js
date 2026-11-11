/**
 * Knowledge tools: ecosystem news cache, deterministic digest and local search.
 *
 * Tool definitions only — `plugin/index.js` registers them after applying the
 * read-only filter and stripping `xClass`.
 *
 * @module plugin/tools/knowledge
 */

import { ok, toErrorResult, renderJson } from '../../lib/result.js'
import { classify } from '../../lib/safety.js'
import { digest, scan, search } from '../../lib/knowledge-store.js'

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

const SOURCE_IDS = ['ha.blog', 'gh.core.releases', 'gh.frontend.releases', 'gh.supervisor.releases']

export const tools = [
  tool(
    'ha_news_scan',
    'Refresh the local knowledge cache from public sources (Home Assistant blog Atom feed and GitHub releases) with conditional HTTP (ETag/Last-Modified). Zero model calls and no Home Assistant data is sent. On network failure the cached index is kept and the failed sources are listed in `stale`.',
    {
      sources: {
        type: 'array',
        items: { type: 'string' },
        description: `Optional source ids; omit for all defaults (${SOURCE_IDS.join(', ')}), plus pypi:<package> or gh.manifest:<domain> on request.`,
      },
      force: {
        type: 'boolean',
        description: 'Ignore cached ETag/Last-Modified and re-fetch (default false).',
      },
    },
    [],
    async (args) => {
      const result = await scan({ sources: args.sources, force: args.force === true })
      const summary = result.offline
        ? `Knowledge sources are offline; serving the cached index (${result.index.count} entries). Stale: ${result.stale.join(', ')}.`
        : `Knowledge scan done: ${result.new_count} new item(s), index ${result.index.count} entries${result.stale.length > 0 ? `; stale: ${result.stale.join(', ')}` : ''}.`
      return ok(summary, result)
    },
  ),
  tool(
    'ha_news_digest',
    'Render the deterministic "what changed in Home Assistant" Markdown digest from the local cache (no model call, no network). Every item carries its source URL and date; stale sources are labelled stale — never present cached notes as current.',
    {
      window_days: {
        type: 'integer',
        minimum: 1,
        maximum: 90,
        description: 'How many days back to include (default 7).',
      },
    },
    [],
    async (args) => {
      const result = await digest({ window_days: args.window_days })
      return ok(`News digest for the last ${result.window_days} day(s): ${result.items_count} item(s).`, result)
    },
  ),
  tool(
    'knowledge_search',
    'Search the local knowledge cache (release notes, blog posts) with BM25-lite token scoring and return short excerpts only, never whole pages. Answers should cite the returned `url` and the `fetched_at`/`as_of` date.',
    {
      query: { type: 'string', description: 'Search terms, e.g. "matter" or "recorder database".' },
      k: { type: 'integer', minimum: 1, maximum: 20, description: 'Number of results (default 5).' },
      sources: { type: 'array', items: { type: 'string' }, description: 'Optional source id filter.' },
      since: { type: ['string', 'number'], description: 'ISO date or number of days back.' },
      max_excerpt: { type: 'integer', minimum: 80, maximum: 600, description: 'Excerpt length per result (default 600).' },
    },
    ['query'],
    async (args) => {
      const result = await search({
        query: args.query,
        k: args.k,
        sources: args.sources,
        since: args.since,
        max_excerpt: args.max_excerpt,
      })
      return ok(`${result.count} result(s) for "${result.query}".`, result)
    },
  ),
]

export default tools
