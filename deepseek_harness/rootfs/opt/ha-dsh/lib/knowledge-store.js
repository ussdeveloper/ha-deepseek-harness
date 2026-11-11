/**
 * Local-first ecosystem knowledge store under `/data/knowledge`.
 *
 * The pipeline is deterministic and costs zero model calls: conditional HTTP
 * (ETag / Last-Modified) against public sources, defensive parsing, a compact
 * local index, a "seen" set and BM25-lite search over short excerpts.
 *
 * Layout:
 * - `index.json`                 compact entries `{id, title, url, published_at, fetched_at, source, tags, excerpt}`
 * - `seen.json`                  item ids already reported by a scan
 * - `cache/<source>/meta.json`   per-source ETag/Last-Modified/error/next_due
 * - `cache/<source>/items.json`  last successfully parsed items (bounded)
 *
 * Network failures never throw out of `scan`: the cache is served and the
 * failed source ids are listed in `stale`.
 *
 * @module knowledge-store
 */

import { join } from 'node:path'

import { getPaths } from './paths.js'
import {
  ToolError,
  isPlainObject,
  nowIso,
  readJson,
  sha256,
  writeJsonAtomic,
} from './result.js'

/** Index schema version. */
export const SCHEMA_VERSION = 1

/** Maximum index entries kept on disk. */
export const MAX_INDEX_ITEMS = 2000

/** Maximum ids kept in `seen.json`. */
export const MAX_SEEN_ITEMS = 5000

/** Maximum excerpt characters stored/returned. */
export const EXCERPT_MAX = 600

/** Maximum response body read from a source (bytes of text). */
export const MAX_BODY_CHARS = 2 * 1024 * 1024

/** Default per-request timeout. */
export const FETCH_TIMEOUT_MS = 15_000

/** Items kept in one source cache file. */
const SOURCE_CACHE_MAX_ITEMS = 200

/** Items returned by one scan. */
const SCAN_NEW_MAX = 40

/** Digest item lines. */
const DIGEST_MAX_ITEMS = 10

/** User agent: identify ourselves, no secrets. */
export const USER_AGENT = 'ha-deepseek-harness/0.1 (+https://www.home-assistant.io/) knowledge-cache'

/** Curated public sources (ha-domain.md §7.2). */
export const SOURCES = Object.freeze({
  'ha.blog': Object.freeze({
    url: 'https://www.home-assistant.io/blog/feed.xml',
    kind: 'atom',
    accept: 'application/atom+xml, application/rss+xml, application/xml;q=0.9, text/xml;q=0.8',
    tags: Object.freeze(['blog']),
    cadence_h: 6,
  }),
  'gh.core.releases': Object.freeze({
    url: 'https://api.github.com/repos/home-assistant/core/releases?per_page=5',
    kind: 'github_releases',
    repo: 'home-assistant/core',
    accept: 'application/vnd.github+json, application/json',
    tags: Object.freeze(['core', 'release']),
    cadence_h: 6,
  }),
  'gh.frontend.releases': Object.freeze({
    url: 'https://api.github.com/repos/home-assistant/frontend/releases?per_page=5',
    kind: 'github_releases',
    repo: 'home-assistant/frontend',
    accept: 'application/vnd.github+json, application/json',
    tags: Object.freeze(['frontend', 'release']),
    cadence_h: 6,
  }),
  'gh.supervisor.releases': Object.freeze({
    url: 'https://api.github.com/repos/home-assistant/supervisor/releases?per_page=5',
    kind: 'github_releases',
    repo: 'home-assistant/supervisor',
    accept: 'application/vnd.github+json, application/json',
    tags: Object.freeze(['supervisor', 'release']),
    cadence_h: 6,
  }),
})

/** Hosts that may be contacted (privacy boundary: public metadata only). */
const ALLOWED_HOSTS = Object.freeze([
  'www.home-assistant.io',
  'home-assistant.io',
  'api.github.com',
  'raw.githubusercontent.com',
  'pypi.org',
])

/** Stop words for the BM25-lite scorer. */
const STOPWORDS = new Set([
  'a', 'an', 'and', 'are', 'as', 'at', 'be', 'by', 'for', 'from', 'has', 'have', 'how', 'i', 'in', 'is', 'it',
  'its', 'of', 'on', 'or', 'that', 'the', 'this', 'to', 'was', 'were', 'what', 'when', 'where', 'which', 'who',
  'will', 'with', 'you', 'your', 'can', 'do', 'does', 'not', 'no', 'yes', 'if', 'then', 'than', 'so', 'up', 'we',
])

/** @returns {{index: string, seen: string, cacheDir: string}} */
export function knowledgeFiles() {
  const dir = getPaths().knowledge
  return { index: join(dir, 'index.json'), seen: join(dir, 'seen.json'), cacheDir: join(dir, 'cache') }
}

/** @param {string} sourceId @returns {string} filesystem-safe source directory name */
export function sourceDirName(sourceId) {
  return sourceId.replace(/[^a-zA-Z0-9_.-]/g, '_').slice(0, 100)
}

/** @param {string} sourceId @returns {{meta: string, items: string}} */
export function sourceFiles(sourceId) {
  const dir = join(knowledgeFiles().cacheDir, sourceDirName(sourceId))
  return { meta: join(dir, 'meta.json'), items: join(dir, 'items.json') }
}

/**
 * Resolve a source id to a fetch spec. Dynamic ids:
 * - `pypi:<package>` for installed integration requirements (public metadata);
 * - `gh.manifest:<domain>` for a core integration manifest on `main`.
 * @param {string} sourceId
 * @returns {object}
 */
export function resolveSource(sourceId) {
  if (typeof sourceId !== 'string' || sourceId.trim() === '') {
    throw new ToolError('INVALID_ARGUMENT', 'A source id is required.')
  }
  const id = sourceId.trim()
  if (Object.hasOwn(SOURCES, id)) return { ...SOURCES[id], id }
  const pypi = id.match(/^pypi:([A-Za-z0-9][A-Za-z0-9._-]{0,80})$/)
  if (pypi !== null) {
    return {
      id,
      url: `https://pypi.org/pypi/${pypi[1]}/json`,
      kind: 'pypi',
      package: pypi[1],
      accept: 'application/json',
      tags: ['pypi', pypi[1]],
      cadence_h: 168,
    }
  }
  const manifest = id.match(/^gh\.manifest:([a-z0-9_]{1,60})$/)
  if (manifest !== null) {
    return {
      id,
      url: `https://raw.githubusercontent.com/home-assistant/core/main/homeassistant/components/${manifest[1]}/manifest.json`,
      kind: 'manifest',
      domain: manifest[1],
      accept: 'application/json',
      tags: ['manifest', manifest[1]],
      cadence_h: 24,
    }
  }
  throw new ToolError('INVALID_ARGUMENT', `Unknown knowledge source "${id}".`, {
    hint: `Known sources: ${Object.keys(SOURCES).join(', ')}, pypi:<package>, gh.manifest:<domain>.`,
  })
}

/** @param {string} raw @returns {string} canonical URL used for dedupe/display */
export function canonicalUrl(raw) {
  const text = String(raw ?? '').trim()
  if (text === '') return ''
  try {
    const url = new URL(text)
    url.hash = ''
    for (const key of [...url.searchParams.keys()]) {
      if (/^(utm_|fbclid$|gclid$|ref$|source$)/i.test(key)) url.searchParams.delete(key)
    }
    let out = url.toString()
    if (url.pathname !== '/' && out.endsWith('/')) out = out.slice(0, -1)
    return out
  } catch {
    return text
  }
}

/** Validate that a URL is public HTTPS on an allowed host. */
function assertPublicUrl(raw) {
  let url
  try {
    url = new URL(raw)
  } catch {
    throw new ToolError('INVALID_ARGUMENT', `Knowledge source URL is not a valid URL: ${raw}`)
  }
  if (url.protocol !== 'https:') throw new ToolError('INVALID_ARGUMENT', `Only HTTPS knowledge sources are allowed: ${raw}`)
  if (!ALLOWED_HOSTS.includes(url.hostname)) {
    throw new ToolError('FORBIDDEN', `Refusing to contact non-allowlisted host: ${url.hostname}`, {
      hint: 'Knowledge fetching is limited to public Home Assistant, GitHub, PyPI and raw.githubusercontent.com URLs.',
    })
  }
  return url
}

/** Decode the handful of XML entities that appear in feed text. */
export function decodeEntities(text) {
  return String(text ?? '')
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/&#x([0-9a-f]+);/gi, (_match, hex) => String.fromCodePoint(Number.parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_match, dec) => String.fromCodePoint(Number.parseInt(dec, 10)))
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

/** Extract the inside of the first matching tag. */
function tagText(xml, tag) {
  const match = String(xml).match(new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)</${tag}>`, 'i'))
  return match === null ? '' : decodeEntities(match[1])
}

/**
 * Parse an Atom/RSS feed into compact items. Defensive: unknown structures
 * yield an empty list, never a throw.
 * @param {string} body
 * @param {object} source resolved source
 * @returns {object[]}
 */
export function parseAtom(body, source) {
  const text = String(body ?? '')
  const blocks = text.match(/<entry\b[\s\S]*?<\/entry>/gi) ?? text.match(/<item\b[\s\S]*?<\/item>/gi) ?? []
  const items = []
  for (const block of blocks.slice(0, 30)) {
    const title = tagText(block, 'title')
    const href = /<link\b[^>]*\bhref=["']([^"']+)["']/i.test(block)
      ? /<link\b[^>]*\bhref=["']([^"']+)["']/i.exec(block)[1]
      : tagText(block, 'link')
    const url = canonicalUrl(href)
    if (title === '' || url === '') continue
    const published = tagText(block, 'published') || tagText(block, 'updated') || tagText(block, 'pubDate') || tagText(block, 'dc:date')
    const excerpt = (tagText(block, 'summary') || tagText(block, 'content') || tagText(block, 'description')).slice(0, EXCERPT_MAX)
    const tags = [...source.tags]
    const version = title.match(/\b(\d{4}\.\d+)(?:\.\d+)?\b/)
    if (version !== null) tags.push('release')
    items.push({
      source: source.id,
      title: title.slice(0, 300),
      url,
      published_at: normalizeDate(published),
      excerpt,
      tags: [...new Set(tags)].slice(0, 10),
    })
  }
  return items
}

/**
 * Parse GitHub releases JSON.
 * @param {string} body
 * @param {object} source
 * @returns {object[]}
 */
export function parseGithubReleases(body, source) {
  let parsed
  try {
    parsed = JSON.parse(String(body ?? ''))
  } catch {
    return []
  }
  if (!Array.isArray(parsed)) return []
  const repo = String(source.repo ?? source.id)
  const items = []
  for (const release of parsed.slice(0, 20)) {
    if (!isPlainObject(release)) continue
    const url = canonicalUrl(release.html_url ?? '')
    if (url === '') continue
    const tag = String(release.tag_name ?? release.name ?? '')
    const bodyText = stripMarkdown(release.body ?? '')
    items.push({
      source: source.id,
      title: `${repo} ${tag}`.trim().slice(0, 300),
      url,
      published_at: normalizeDate(release.published_at ?? release.created_at ?? ''),
      excerpt: bodyText.slice(0, EXCERPT_MAX),
      tags: [...new Set([...source.tags, tag].filter((tag) => tag !== ''))].slice(0, 10),
    })
  }
  return items
}

/**
 * Parse the PyPI JSON API response.
 * @param {string} body
 * @param {object} source
 * @returns {object[]}
 */
export function parsePypi(body, source) {
  let parsed
  try {
    parsed = JSON.parse(String(body ?? ''))
  } catch {
    return []
  }
  const info = isPlainObject(parsed?.info) ? parsed.info : {}
  const name = String(info.name ?? source.package ?? '')
  const version = String(info.version ?? '')
  if (name === '' || version === '') return []
  const releases = isPlainObject(parsed?.releases) ? parsed.releases : {}
  const files = Array.isArray(releases[version]) ? releases[version] : []
  const upload = files.find((file) => typeof file?.upload_time_iso_8601 === 'string')?.upload_time_iso_8601
    ?? files.find((file) => typeof file?.upload_time === 'string')?.upload_time
    ?? ''
  return [{
    source: source.id,
    title: `${name} ${version}`,
    url: `https://pypi.org/project/${encodeURIComponent(name)}/${encodeURIComponent(version)}/`,
    published_at: normalizeDate(upload),
    excerpt: String(info.summary ?? '').slice(0, EXCERPT_MAX),
    tags: [...new Set([...source.tags, version].filter((tag) => tag !== ''))].slice(0, 10),
  }]
}

/**
 * Parse a Home Assistant core integration manifest (public metadata only).
 * @param {string} body
 * @param {object} source
 * @returns {object[]}
 */
export function parseManifest(body, source) {
  let parsed
  try {
    parsed = JSON.parse(String(body ?? ''))
  } catch {
    return []
  }
  if (!isPlainObject(parsed)) return []
  const domain = String(source.domain ?? '')
  const requirements = Array.isArray(parsed.requirements) ? parsed.requirements : []
  const excerpt = [
    parsed.integration_type === undefined ? '' : `type: ${parsed.integration_type}`,
    parsed.quality_scale === undefined ? '' : `quality: ${parsed.quality_scale}`,
    requirements.length === 0 ? '' : `requirements: ${requirements.join(', ')}`,
  ].filter((part) => part !== '').join('; ')
  return [{
    source: source.id,
    title: `${domain} manifest`,
    url: `https://github.com/home-assistant/core/blob/main/homeassistant/components/${domain}/manifest.json`,
    published_at: null,
    excerpt: excerpt.slice(0, EXCERPT_MAX),
    tags: ['manifest', domain, String(parsed.integration_type ?? '')].filter((tag) => tag !== '').slice(0, 10),
  }]
}

/** @param {string} text @returns {string} */
function stripMarkdown(text) {
  return String(text ?? '')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/[#>*_`~]+/g, ' ')
    .replace(/\r/g, '')
    .replace(/\s+/g, ' ')
    .trim()
}

/** @param {unknown} value @returns {string|null} ISO date or null */
function normalizeDate(value) {
  const text = String(value ?? '').trim()
  if (text === '') return null
  const parsed = Date.parse(text)
  if (!Number.isFinite(parsed)) return null
  return new Date(parsed).toISOString()
}

/** @param {string} sourceId @returns {Promise<object>} */
export async function readSourceMeta(sourceId) {
  const raw = await readJson(sourceFiles(sourceId).meta, null)
  return {
    source: sourceId,
    etag: typeof raw?.etag === 'string' ? raw.etag : null,
    last_modified: typeof raw?.last_modified === 'string' ? raw.last_modified : null,
    last_checked: typeof raw?.last_checked === 'string' ? raw.last_checked : null,
    last_success: typeof raw?.last_success === 'string' ? raw.last_success : null,
    last_error: typeof raw?.last_error === 'string' ? raw.last_error : null,
    next_due: typeof raw?.next_due === 'string' ? raw.next_due : null,
    fail_count: Number.isFinite(Number(raw?.fail_count)) ? Number(raw.fail_count) : 0,
    items_count: Number.isFinite(Number(raw?.items_count)) ? Number(raw.items_count) : 0,
  }
}

/** @param {string} sourceId @param {object} meta */
async function writeSourceMeta(sourceId, meta) {
  await writeJsonAtomic(sourceFiles(sourceId).meta, meta)
}

/** @param {string} sourceId @param {object[]} items */
async function writeSourceItems(sourceId, items) {
  await writeJsonAtomic(sourceFiles(sourceId).items, {
    source: sourceId,
    fetched_at: nowIso(),
    count: items.length,
    items: items.slice(0, SOURCE_CACHE_MAX_ITEMS),
  })
}

/** @returns {Promise<{version: number, updated_at: string|null, items: object[]}>} */
export async function readIndex() {
  const raw = await readJson(knowledgeFiles().index, null)
  const items = Array.isArray(raw?.items) ? raw.items.filter((item) => isPlainObject(item) && typeof item.id === 'string') : []
  return {
    version: SCHEMA_VERSION,
    updated_at: typeof raw?.updated_at === 'string' ? raw.updated_at : null,
    items,
  }
}

/** @returns {Promise<{version: number, updated_at: string|null, seen: Record<string, string>}>} */
export async function readSeen() {
  const raw = await readJson(knowledgeFiles().seen, null)
  const seen = isPlainObject(raw?.seen) ? raw.seen : {}
  return {
    version: SCHEMA_VERSION,
    updated_at: typeof raw?.updated_at === 'string' ? raw.updated_at : null,
    seen,
  }
}

/** @param {object[]} items @returns {number} sortable timestamp */
function itemTime(item) {
  const published = Date.parse(String(item?.published_at ?? ''))
  if (Number.isFinite(published)) return published
  const fetched = Date.parse(String(item?.fetched_at ?? ''))
  return Number.isFinite(fetched) ? fetched : 0
}

/** @param {object[]} list @returns {object[]} newest first, stable tie-break */
function sortItems(list) {
  return [...list].sort((a, b) => {
    const delta = itemTime(b) - itemTime(a)
    if (delta !== 0) return delta
    return String(a.id ?? a.url ?? '').localeCompare(String(b.id ?? b.url ?? ''))
  })
}

/**
 * Fetch one source. Returns a result object; never throws for network errors
 * (throws only for an unknown/invalid source definition).
 * @param {string} sourceId
 * @param {{ force?: boolean, timeout_ms?: number, fetchImpl?: typeof fetch }} [options]
 * @returns {Promise<object>}
 */
export async function fetchSource(sourceId, options = {}) {
  const source = resolveSource(sourceId)
  assertPublicUrl(source.url)
  const meta = await readSourceMeta(sourceId)
  const timeoutMs = Number.isFinite(Number(options.timeout_ms)) ? Number(options.timeout_ms) : FETCH_TIMEOUT_MS
  const fetchImpl = typeof options.fetchImpl === 'function' ? options.fetchImpl : globalThis.fetch
  /** @type {Record<string, string>} */
  const headers = { 'user-agent': USER_AGENT, accept: source.accept }
  if (options.force !== true) {
    if (meta.etag !== null) headers['if-none-match'] = meta.etag
    if (meta.last_modified !== null) headers['if-modified-since'] = meta.last_modified
  }
  const startedAt = nowIso()
  let response
  try {
    response = await fetchImpl(source.url, {
      method: 'GET',
      headers,
      redirect: 'follow',
      signal: AbortSignal.timeout(timeoutMs),
    })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    meta.last_checked = startedAt
    meta.last_error = `network: ${message}`.slice(0, 300)
    meta.fail_count += 1
    meta.next_due = new Date(Date.now() + backoffMs(meta.fail_count)).toISOString()
    await writeSourceMeta(sourceId, meta)
    return { source: sourceId, status: 'error', error: meta.last_error, items: [], meta }
  }

  if (response.status === 304) {
    meta.last_checked = startedAt
    meta.last_error = null
    meta.fail_count = 0
    meta.next_due = new Date(Date.now() + source.cadence_h * 3_600_000).toISOString()
    await writeSourceMeta(sourceId, meta)
    return { source: sourceId, status: 'not_modified', items: [], meta }
  }

  let text = ''
  try {
    text = await response.text()
  } catch (error) {
    text = ''
  }
  if (!response.ok) {
    meta.last_checked = startedAt
    meta.last_error = `HTTP ${response.status}`
    meta.fail_count += 1
    meta.next_due = new Date(Date.now() + backoffMs(meta.fail_count)).toISOString()
    await writeSourceMeta(sourceId, meta)
    return { source: sourceId, status: 'error', error: meta.last_error, items: [], http_status: response.status, meta }
  }
  if (text.length > MAX_BODY_CHARS) text = text.slice(0, MAX_BODY_CHARS)

  const items = parseSourceBody(source, text)
  const etag = response.headers?.get?.('etag') ?? null
  const lastModified = response.headers?.get?.('last-modified') ?? null
  meta.last_checked = startedAt
  meta.last_success = startedAt
  meta.last_error = null
  meta.fail_count = 0
  meta.etag = typeof etag === 'string' && etag !== '' ? etag : meta.etag
  meta.last_modified = typeof lastModified === 'string' && lastModified !== '' ? lastModified : meta.last_modified
  meta.next_due = new Date(Date.now() + source.cadence_h * 3_600_000).toISOString()
  meta.items_count = items.length
  if (items.length > 0) await writeSourceItems(sourceId, items)
  await writeSourceMeta(sourceId, meta)
  return {
    source: sourceId,
    status: items.length > 0 ? 'ok' : 'partial',
    items,
    error: items.length > 0 ? undefined : 'no items could be parsed from the response',
    meta,
  }
}

/** @param {number} failCount @returns {number} exponential backoff, capped at 1 h */
function backoffMs(failCount) {
  return Math.min(3_600_000, 60_000 * 2 ** Math.min(6, Math.max(0, failCount - 1)))
}

/** @param {object} source @param {string} body @returns {object[]} */
function parseSourceBody(source, body) {
  try {
    if (source.kind === 'atom') return parseAtom(body, source)
    if (source.kind === 'github_releases') return parseGithubReleases(body, source)
    if (source.kind === 'pypi') return parsePypi(body, source)
    if (source.kind === 'manifest') return parseManifest(body, source)
    return []
  } catch {
    return []
  }
}

/**
 * Scan sources and update the local index and seen set.
 * @param {{ sources?: string[], force?: boolean, timeout_ms?: number }} [options]
 * @returns {Promise<object>}
 */
export async function scan(options = {}) {
  const requested = Array.isArray(options.sources) && options.sources.length > 0 ? options.sources.map(String) : Object.keys(SOURCES)
  const results = []
  /** @type {object[]} */
  const fetchedItems = []
  /** @type {string[]} */
  const stale = []
  let okCount = 0
  let attempted = 0

  for (const sourceId of requested) {
    try {
      resolveSource(sourceId)
    } catch (error) {
      results.push({ source: sourceId, status: 'invalid', error: errorMessage(error) })
      continue
    }
    attempted += 1
    let outcome
    try {
      outcome = await fetchSource(sourceId, { force: options.force === true, timeout_ms: options.timeout_ms })
    } catch (error) {
      outcome = { source: sourceId, status: 'error', error: errorMessage(error), items: [] }
    }
    if (outcome.status === 'ok' || outcome.status === 'partial') {
      okCount += 1
      fetchedItems.push(...outcome.items)
      results.push({
        source: sourceId,
        status: outcome.status,
        fetched: outcome.items.length,
        etag: outcome.meta?.etag ?? null,
        last_checked: outcome.meta?.last_checked ?? null,
        ...(outcome.error === undefined ? {} : { warning: outcome.error }),
      })
    } else if (outcome.status === 'not_modified') {
      okCount += 1
      results.push({
        source: sourceId,
        status: outcome.status,
        fetched: 0,
        etag: outcome.meta?.etag ?? null,
        last_checked: outcome.meta?.last_checked ?? null,
      })
    } else {
      stale.push(sourceId)
      results.push({
        source: sourceId,
        status: outcome.status ?? 'error',
        fetched: 0,
        error: outcome.error ?? 'unknown error',
        ...(outcome.http_status === undefined ? {} : { http_status: outcome.http_status }),
      })
    }
  }

  const merge = await mergeIndex(fetchedItems)
  const seen = await readSeen()
  const fresh = merge.added.filter((item) => !(item.id in seen.seen))
  const scannedAt = nowIso()
  for (const item of fresh) seen.seen[item.id] = scannedAt
  const seenEntries = Object.entries(seen.seen)
    .sort((a, b) => String(b[1]).localeCompare(String(a[1])))
    .slice(0, MAX_SEEN_ITEMS)
  await writeJsonAtomic(knowledgeFiles().seen, {
    version: SCHEMA_VERSION,
    updated_at: scannedAt,
    seen: Object.fromEntries(seenEntries),
  })

  const newItems = sortItems(fresh).slice(0, SCAN_NEW_MAX).map((item) => ({
    title: item.title,
    url: item.url,
    published_at: item.published_at,
    fetched_at: item.fetched_at,
    source: item.source,
    tags: item.tags,
    excerpt: item.excerpt,
  }))
  return {
    scanned_at: scannedAt,
    results,
    new_count: fresh.length,
    new_items: newItems,
    stale,
    offline: attempted > 0 && okCount === 0,
    index: { count: merge.index.items.length, updated_at: merge.index.updated_at },
    fetched_count: fetchedItems.length,
  }
}

/** @param {object[]} items @returns {Promise<{added: object[], index: object}>} */
async function mergeIndex(items) {
  const index = await readIndex()
  const byId = new Map(index.items.map((item) => [item.id, item]))
  const added = []
  for (const item of items) {
    if (!isPlainObject(item)) continue
    const url = canonicalUrl(item.url)
    if (url === '') continue
    const id = sha256(`${item.source}\u0000${url}`).slice(0, 20)
    const entry = {
      id,
      title: String(item.title ?? '').slice(0, 300),
      url,
      published_at: typeof item.published_at === 'string' ? item.published_at : null,
      fetched_at: nowIso(),
      source: String(item.source ?? ''),
      tags: Array.isArray(item.tags) ? item.tags.map(String).slice(0, 10) : [],
      excerpt: String(item.excerpt ?? '').slice(0, EXCERPT_MAX),
    }
    const existing = byId.get(id)
    if (existing === undefined) {
      byId.set(id, entry)
      added.push(entry)
    } else {
      existing.fetched_at = entry.fetched_at
      if (entry.excerpt !== '') existing.excerpt = entry.excerpt
      if (entry.published_at !== null) existing.published_at = entry.published_at
    }
  }
  const merged = sortItems([...byId.values()]).slice(0, MAX_INDEX_ITEMS)
  const updated = {
    version: SCHEMA_VERSION,
    updated_at: nowIso(),
    count: merged.length,
    items: merged,
  }
  await writeJsonAtomic(knowledgeFiles().index, updated)
  return { added, index: updated }
}

/** @returns {Promise<string[]>} sources whose last fetch failed */
export async function staleSources() {
  const stale = new Set()
  for (const sourceId of Object.keys(SOURCES)) {
    const meta = await readSourceMeta(sourceId)
    if (meta.last_error !== null) stale.add(sourceId)
  }
  return [...stale].sort()
}

/**
 * Deterministic Markdown "what's new" digest (≤15 lines, no model call).
 * @param {{ window_days?: number }} [options]
 * @returns {Promise<object>}
 */
export async function digest(options = {}) {
  const windowDays = Number.isFinite(Number(options.window_days)) ? Math.max(1, Math.min(90, Number(options.window_days))) : 7
  const index = await readIndex()
  const cutoff = Date.now() - windowDays * 86_400_000
  const inWindow = sortItems(index.items.filter((item) => itemTime(item) >= cutoff))
  const lines = []
  lines.push(`## Home Assistant — what's new (last ${windowDays} days)`)
  lines.push('')
  if (inWindow.length === 0) {
    lines.push(`Nothing new found in the local cache. Cache updated ${index.updated_at ?? 'never'}.`)
  } else {
    for (const item of inWindow.slice(0, DIGEST_MAX_ITEMS)) {
      const date = String(item.published_at ?? item.fetched_at ?? '').slice(0, 10)
      const excerpt = String(item.excerpt ?? '').replace(/\s+/g, ' ').slice(0, 140)
      lines.push(`- **${date}** [${item.source}] ${item.title}${excerpt === '' ? '' : ` — ${excerpt}`} (${item.url})`)
    }
    if (inWindow.length > DIGEST_MAX_ITEMS) lines.push(`- … and ${inWindow.length - DIGEST_MAX_ITEMS} more item(s) in the cache.`)
  }
  lines.push('')
  const perSource = {}
  for (const item of inWindow) perSource[item.source] = (perSource[item.source] ?? 0) + 1
  const sourceText = Object.entries(perSource).map(([source, count]) => `${source}(${count})`).join(', ')
  lines.push(`Sources: ${sourceText === '' ? 'none' : sourceText} · cached as of ${index.updated_at ?? 'never'}`)
  const stale = await staleSources()
  if (stale.length > 0) {
    lines.push(`Some sources could not be refreshed (offline or rate-limited): ${stale.join(', ')}. Cache only; do not present as current.`)
  }
  const trimmed = lines.slice(0, 15)
  return {
    markdown: trimmed.join('\n'),
    lines: trimmed.length,
    window_days: windowDays,
    items_count: inWindow.length,
    sources: stale,
    index: { count: index.items.length, updated_at: index.updated_at },
  }
}

/** @param {string} value @returns {string[]} */
export function tokenize(value) {
  return String(value ?? '')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .map((token) => token.trim())
    .filter((token) => token.length >= 2 && !STOPWORDS.has(token))
}

/**
 * BM25-lite scoring over the local index; returns excerpts only.
 * @param {{
 *   query: string, k?: number, sources?: string[], since?: string|number,
 *   max_excerpt?: number,
 * }} options
 * @returns {Promise<object>}
 */
export async function search(options = {}) {
  const query = typeof options.query === 'string' ? options.query : ''
  const tokens = tokenize(query)
  const k = Number.isFinite(Number(options.k)) ? Math.max(1, Math.min(20, Math.trunc(Number(options.k)))) : 5
  const maxExcerpt = Number.isFinite(Number(options.max_excerpt))
    ? Math.max(80, Math.min(EXCERPT_MAX, Math.trunc(Number(options.max_excerpt))))
    : EXCERPT_MAX
  const index = await readIndex()
  if (tokens.length === 0) {
    return { query, tokens: [], results: [], count: 0, index_updated_at: index.updated_at, note: 'Empty or stop-word-only query.' }
  }
  let sinceMs = Number.NEGATIVE_INFINITY
  if (typeof options.since === 'number' && Number.isFinite(options.since)) sinceMs = Date.now() - Math.max(0, options.since) * 86_400_000
  else if (typeof options.since === 'string' && options.since !== '') {
    const parsed = Date.parse(options.since)
    if (Number.isFinite(parsed)) sinceMs = parsed
  }
  const sources = Array.isArray(options.sources) && options.sources.length > 0 ? new Set(options.sources.map(String)) : null
  const docs = index.items.filter((item) => {
    if (sources !== null && !sources.has(item.source)) return false
    return itemTime(item) >= sinceMs
  })
  if (docs.length === 0) {
    return { query, tokens, results: [], count: 0, index_updated_at: index.updated_at }
  }

  const fields = (item) => ({
    title: tokenize(item.title),
    tags: tokenize((item.tags ?? []).join(' ')),
    body: tokenize(item.excerpt),
  })
  const weights = { title: 3, tags: 2, body: 1 }
  const docFields = docs.map(fields)
  const docLengths = docFields.map((field) => field.title.length * weights.title + field.tags.length * weights.tags + field.body.length * weights.body)
  const avgdl = docLengths.reduce((sum, length) => sum + length, 0) / docs.length || 1
  const df = {}
  for (const token of tokens) {
    df[token] = 0
    for (const field of docFields) {
      if (field.title.includes(token) || field.tags.includes(token) || field.body.includes(token)) df[token] += 1
    }
  }
  const k1 = 1.2
  const b = 0.75
  const scored = []
  docs.forEach((item, index_) => {
    const field = docFields[index_]
    const length = docLengths[index_] || 1
    let score = 0
    for (const token of tokens) {
      const tf = field.title.filter((value) => value === token).length * weights.title
        + field.tags.filter((value) => value === token).length * weights.tags
        + field.body.filter((value) => value === token).length * weights.body
      if (tf === 0) continue
      const idf = Math.log(1 + (docs.length - df[token] + 0.5) / (df[token] + 0.5))
      score += idf * ((tf * (k1 + 1)) / (tf + k1 * (1 - b + b * (length / avgdl))))
    }
    if (score > 0) scored.push({ item, score })
  })
  scored.sort((a, b_) => b_.score - a.score || String(a.item.id).localeCompare(String(b_.item.id)))
  const results = scored.slice(0, k).map(({ item, score }) => ({
    title: item.title,
    url: item.url,
    source: item.source,
    published_at: item.published_at,
    fetched_at: item.fetched_at,
    tags: item.tags,
    score: Math.round(score * 1000) / 1000,
    excerpt: String(item.excerpt ?? '').replace(/\s+/g, ' ').slice(0, maxExcerpt),
  }))
  return {
    query,
    tokens,
    results,
    count: results.length,
    index_updated_at: index.updated_at,
    as_of: index.updated_at,
  }
}

/** @param {unknown} error @returns {string} */
function errorMessage(error) {
  return error instanceof Error ? error.message : String(error)
}
