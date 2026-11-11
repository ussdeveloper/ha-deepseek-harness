/**
 * Safe access to the Home Assistant configuration directory.
 *
 * The add-on mounts HA's `/config` read/write, but raw writes would bypass
 * validation, snapshots and the deny-lists. Every config tool goes through this
 * module, which:
 *
 * - resolves paths through `lib/safety.js#assertSafeConfigPath` (no traversal,
 *   no `.storage`, no databases, no runtime-managed files);
 * - snapshots the previous state under `/data/config-backups/<ts>-<label>/`
 *   with a `manifest.json` before changing anything;
 * - checks `base_sha256` before overwriting (optimistic concurrency: a change
 *   made in the HA UI in between must not be clobbered);
 * - writes atomically (temp file + rename in the same directory);
 * - validates through Home Assistant's own `POST /api/config/core/check_config`
 *   (authoritative) and rolls the change back when it is invalid, with a
 *   lightweight YAML sanity check (tabs / unbalanced quotes and brackets) only
 *   as a clearly-labelled fallback when Home Assistant is unreachable.
 *
 * @module config-files
 */

import { mkdir, readFile, readdir, rename, rm, stat, unlink, writeFile } from 'node:fs/promises'
import { basename, dirname, join, relative, resolve } from 'node:path'
import { randomBytes } from 'node:crypto'

import { getPaths } from './paths.js'
import { sha256, ToolError } from './result.js'
import { assertSafeConfigPath, isCoreConfigFile } from './safety.js'
import { checkConfig } from './ha-core.js'

/** Files that carry secret values and are never read or rewritten by tools. */
const SECRET_FILES = new Set(['secrets.yaml', 'secrets.yml'])

/** Maximum characters of unified diff returned by a write/edit. */
const MAX_DIFF_LINES = 400

/** @returns {string} resolved HA config root */
export function configRoot() {
  return resolve(getPaths().configDir)
}

/** Convert a native path fragment to POSIX-style separators. */
function toPosix(value) {
  return String(value).replaceAll('\\', '/')
}

/** @param {string} name @returns {boolean} */
function isDeniedName(name) {
  if (name === '.storage' || name === 'deps' || name === 'tts' || name === '.cloud' || name === '.git') return true
  if (name === 'home-assistant.log') return true
  return /\.(db|db-wal|db-shm|sqlite|sqlite3)$/i.test(name)
}

/** @param {string} name @returns {boolean} */
function isSecretFile(name) {
  return SECRET_FILES.has(name.toLowerCase())
}

/**
 * Resolve a config-relative path to an absolute path inside the config dir.
 * Throws `FORBIDDEN` for traversal/deny-listed targets.
 * @param {string} [relativePath] path relative to the config root, POSIX style
 * @returns {string} absolute path
 */
export function resolveConfigPath(relativePath = '.') {
  const raw = relativePath === undefined || relativePath === null || relativePath === '' || relativePath === '.' ? '/' : relativePath
  const safe = assertSafeConfigPath(raw)
  const root = configRoot()
  const segments = safe.split('/').filter((segment) => segment !== '')
  const target = resolve(root, ...segments)
  const rel = relative(root, target)
  if (rel.startsWith('..') || resolve(root, rel) !== target) {
    throw new ToolError('FORBIDDEN', `Path escapes the configuration directory: ${relativePath}`)
  }
  return target
}

/**
 * Relative POSIX path of an absolute config path.
 * @param {string} absolute
 * @returns {string} `''` for the config root itself
 */
export function configRelative(absolute) {
  return toPosix(relative(configRoot(), absolute))
}

/**
 * Refuse to touch files that hold secret values: their content must never be
 * pulled into a model context, and a blind rewrite would destroy secrets.
 * @param {string} relativePosix
 * @param {string} action
 */
function guardSecretFile(relativePosix, action) {
  if (isSecretFile(basename(relativePosix))) {
    throw new ToolError(
      'FORBIDDEN',
      `Refusing to ${action} ${relativePosix}: secret values must not be read or rewritten by tools.`,
      {
        hint: 'Edit secrets.yaml in the Home Assistant UI (Settings → System → Secrets) and reference values with !secret.',
      },
    )
  }
}

/**
 * Map Node filesystem errors to the tool error taxonomy.
 * @param {unknown} error
 * @param {string} label
 * @returns {ToolError}
 */
function fsError(error, label) {
  const code = /** @type {NodeJS.ErrnoException} */ (error)?.code
  if (code === 'ENOENT') return new ToolError('NOT_FOUND', `No such config path: ${label}`)
  if (code === 'EACCES' || code === 'EPERM') {
    return new ToolError('FORBIDDEN', `The configuration path is not accessible: ${label}`)
  }
  if (code === 'EISDIR') return new ToolError('INVALID_ARGUMENT', `Expected a file but found a directory: ${label}`)
  if (code === 'ENOTDIR') return new ToolError('INVALID_ARGUMENT', `Expected a directory but found a file: ${label}`)
  const message = error instanceof Error ? error.message : String(error)
  return new ToolError('INTERNAL', `Config filesystem error on ${label}: ${message}`)
}

/**
 * List one config directory tree (directories and files, bounded).
 * @param {{ path?: string, depth?: number, includeHidden?: boolean, limit?: number }} [options]
 * @returns {Promise<{ path: string, entries: object[], count: number, truncated: boolean }>}
 */
export async function listConfig(options = {}) {
  const { path = '.', depth = 2, includeHidden = false, limit = 500 } = options
  const target = resolveConfigPath(path === '/' ? '/' : path)
  const baseRel = configRelative(target)
  const entries = []
  let truncated = false

  /** @param {string} dir @param {string} rel @param {number} level */
  const walk = async (dir, rel, level) => {
    if (entries.length >= limit) {
      truncated = true
      return
    }
    let dirents
    try {
      dirents = await readdir(dir, { withFileTypes: true })
    } catch (error) {
      throw fsError(error, rel === '' ? '/' : rel)
    }
    for (const dirent of dirents) {
      if (entries.length >= limit) {
        truncated = true
        return
      }
      if (!includeHidden && dirent.name.startsWith('.')) continue
      if (isDeniedName(dirent.name)) continue
      const childRel = rel === '' ? dirent.name : `${rel}/${dirent.name}`
      const childAbs = join(dir, dirent.name)
      if (dirent.isDirectory()) {
        entries.push({ path: `${childRel}/`, type: 'directory' })
        if (level + 1 < depth) await walk(childAbs, childRel, level + 1)
      } else if (dirent.isFile() || dirent.isSymbolicLink()) {
        let info
        try {
          info = await stat(childAbs)
        } catch {
          continue
        }
        entries.push({
          path: childRel,
          type: 'file',
          bytes: info.size,
          mtime: new Date(info.mtimeMs).toISOString(),
        })
      }
    }
  }
  await walk(target, baseRel, 0)
  entries.sort((left, right) => left.path.localeCompare(right.path))
  return { path: baseRel === '' ? '/' : baseRel, entries, count: entries.length, truncated }
}

/**
 * Read one config file, with its SHA-256 base for later writes.
 * @param {{ path: string, maxBytes?: number, startLine?: number, endLine?: number }} options
 * @returns {Promise<object>}
 */
export async function readConfigFile(options) {
  const { path, maxBytes = 65536, startLine = undefined, endLine = undefined } = options ?? {}
  if (typeof path !== 'string' || path.trim() === '') {
    throw new ToolError('INVALID_ARGUMENT', 'path is required.')
  }
  const target = resolveConfigPath(path)
  const rel = configRelative(target)
  guardSecretFile(rel, 'read')
  let buffer
  try {
    buffer = await readFile(target)
  } catch (error) {
    throw fsError(error, rel)
  }
  if (buffer.includes(0)) {
    throw new ToolError('FORBIDDEN', `Refusing to read binary file: ${rel}`, {
      hint: 'Only text configuration files are exposed through these tools.',
    })
  }
  const text = buffer.toString('utf8')
  const allLines = text.split('\n')
  let content = text
  if (startLine !== undefined || endLine !== undefined) {
    const start = Math.max(1, Number(startLine ?? 1))
    const end = endLine === undefined ? allLines.length : Math.max(start, Number(endLine))
    content = allLines.slice(start - 1, end).join('\n')
  }
  let truncated = false
  if (content.length > maxBytes) {
    content = content.slice(0, maxBytes)
    truncated = true
  }
  return {
    path: rel,
    content,
    sha256: sha256(text),
    bytes: buffer.length,
    line_count: allLines.length,
    truncated,
  }
}

/**
 * Glob (limited: `*`, `?`, `**`) to a RegExp over POSIX relative paths.
 * @param {string} glob
 * @returns {RegExp}
 */
function globToRegExp(glob) {
  const source = String(glob).replaceAll('\\', '/')
  let out = '^'
  for (let index = 0; index < source.length; index += 1) {
    const char = source[index]
    if (char === '*') {
      if (source[index + 1] === '*') {
        index += 1
        if (source[index + 1] === '/') {
          index += 1
          out += '(?:.*/)?'
        } else {
          out += '.*'
        }
      } else {
        out += '[^/]*'
      }
      continue
    }
    if (char === '?') {
      out += '[^/]'
      continue
    }
    out += char.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  }
  return new RegExp(`${out}$`)
}

/**
 * Walk files below the config root, skipping denied subtrees and binaries.
 * @param {string} root
 * @param {{ maxFiles?: number, maxDepth?: number, includeHidden?: boolean, onFile: (absolute: string, relativePosix: string) => Promise<void> }} options
 * @returns {Promise<{ files: number, truncated: boolean }>}
 */
async function walkFiles(root, options) {
  const { maxFiles = 2000, maxDepth = 12, includeHidden = false, onFile } = options
  const stack = [{ dir: root, rel: '', depth: 0 }]
  let files = 0
  let truncated = false
  while (stack.length > 0) {
    const current = stack.pop()
    let dirents
    try {
      dirents = await readdir(current.dir, { withFileTypes: true })
    } catch {
      continue
    }
    for (const dirent of dirents) {
      if (files >= maxFiles) {
        truncated = true
        break
      }
      if (!includeHidden && dirent.name.startsWith('.')) continue
      if (isDeniedName(dirent.name)) continue
      const childRel = current.rel === '' ? dirent.name : `${current.rel}/${dirent.name}`
      const childAbs = join(current.dir, dirent.name)
      if (dirent.isDirectory()) {
        if (current.depth < maxDepth) {
          stack.push({ dir: childAbs, rel: childRel, depth: current.depth + 1 })
        }
        continue
      }
      if (!dirent.isFile()) continue
      files += 1
      try {
        await onFile(childAbs, childRel)
      } catch {
        /* a single unreadable file must not abort the whole search */
      }
    }
    if (truncated) break
  }
  return { files, truncated }
}

/**
 * Grep-like regex search across config files.
 * @param {{ query: string, glob?: string, path?: string, maxResults?: number, ignoreCase?: boolean, includeHidden?: boolean, maxFileBytes?: number }} options
 * @returns {Promise<object>}
 */
export async function searchConfig(options) {
  const {
    query,
    glob = '*.yaml',
    path = '.',
    maxResults = 50,
    ignoreCase = true,
    includeHidden = false,
    maxFileBytes = 1_048_576,
  } = options ?? {}
  if (typeof query !== 'string' || query === '') {
    throw new ToolError('INVALID_ARGUMENT', 'query (a regular expression) is required.')
  }
  let pattern
  try {
    pattern = new RegExp(query, ignoreCase ? 'i' : '')
  } catch (error) {
    throw new ToolError('INVALID_ARGUMENT', `query is not a valid regular expression: ${error.message}`)
  }
  let filePattern
  try {
    filePattern = globToRegExp(glob)
  } catch {
    throw new ToolError('INVALID_ARGUMENT', `glob is not valid: ${glob}`)
  }
  const target = resolveConfigPath(path === '/' ? '/' : path)
  const baseRel = configRelative(target)
  const matches = []
  let truncated = false
  const seen = { files: 0 }
  // Search below the requested path, matching the glob against the config-relative path.
  await walkFiles(target, {
    includeHidden,
    maxFiles: 3000,
    async onFile(absolute, relBelow) {
      seen.files += 1
      if (matches.length >= maxResults) {
        truncated = true
        return
      }
      const relativePosix = baseRel === '' ? relBelow : `${baseRel}/${relBelow}`
      if (!filePattern.test(relativePosix)) return
      if (isSecretFile(basename(relativePosix))) {
        matches.push({ path: relativePosix, line: 0, text: '[secrets.yaml content is not searched]' })
        return
      }
      let info
      try {
        info = await stat(absolute)
      } catch {
        return
      }
      if (info.size > maxFileBytes) return
      let buffer
      try {
        buffer = await readFile(absolute)
      } catch {
        return
      }
      if (buffer.includes(0)) return
      const lines = buffer.toString('utf8').split('\n')
      for (let index = 0; index < lines.length; index += 1) {
        if (matches.length >= maxResults) {
          truncated = true
          return
        }
        if (pattern.test(lines[index])) {
          matches.push({
            path: relativePosix,
            line: index + 1,
            text: lines[index].length > 300 ? `${lines[index].slice(0, 300)}…` : lines[index],
          })
        }
      }
    },
  })
  return { query, glob, path: baseRel === '' ? '/' : baseRel, matches, files_searched: seen.files, truncated }
}

/**
 * Line-based diff (bounded). Returns counts plus a unified-style body; large
 * inputs degrade to counts only so a tool result stays small.
 * @param {string} before
 * @param {string} after
 * @returns {{ changed: boolean, added: number, removed: number, unified: string, truncated: boolean }}
 */
export function diffLines(before, after) {
  const changed = before !== after
  if (!changed) return { changed: false, added: 0, removed: 0, unified: '', truncated: false }
  const left = before === '' ? [] : String(before).split('\n')
  const right = after === '' ? [] : String(after).split('\n')
  if (left.length + right.length > 1500) {
    return {
      changed: true,
      added: right.length,
      removed: left.length,
      unified: '[diff too large: line counts only]',
      truncated: true,
    }
  }
  // Classic LCS table; bounded above, so the memory cost is acceptable.
  const rows = left.length + 1
  const cols = right.length + 1
  const table = new Uint32Array(rows * cols)
  for (let i = left.length - 1; i >= 0; i -= 1) {
    for (let j = right.length - 1; j >= 0; j -= 1) {
      table[i * cols + j] =
        left[i] === right[j]
          ? table[(i + 1) * cols + j + 1] + 1
          : Math.max(table[(i + 1) * cols + j], table[i * cols + j + 1])
    }
  }
  let added = 0
  let removed = 0
  const body = []
  let i = 0
  let j = 0
  while (i < left.length && j < right.length) {
    if (left[i] === right[j]) {
      if (body.length < MAX_DIFF_LINES) body.push(` ${left[i]}`)
      i += 1
      j += 1
    } else if (table[(i + 1) * cols + j] >= table[i * cols + j + 1]) {
      if (body.length < MAX_DIFF_LINES) body.push(`-${left[i]}`)
      removed += 1
      i += 1
    } else {
      if (body.length < MAX_DIFF_LINES) body.push(`+${right[j]}`)
      added += 1
      j += 1
    }
  }
  while (i < left.length) {
    if (body.length < MAX_DIFF_LINES) body.push(`-${left[i]}`)
    removed += 1
    i += 1
  }
  while (j < right.length) {
    if (body.length < MAX_DIFF_LINES) body.push(`+${right[j]}`)
    added += 1
    j += 1
  }
  const truncated = body.length >= MAX_DIFF_LINES
  return {
    changed: true,
    added,
    removed,
    unified: body.join('\n') + (truncated ? '\n…[diff truncated]' : ''),
    truncated,
  }
}

/**
 * Lightweight YAML sanity check used ONLY when Home Assistant's authoritative
 * config check is unreachable. Explicitly syntax-only; it cannot prove validity.
 * @param {string} text
 * @returns {{ ok: boolean, issues: object[], scope: 'syntax-only' }}
 */
export function yamlSanityCheck(text) {
  const source = String(text ?? '')
  const lines = source.split('\n')
  const issues = []
  lines.forEach((line, index) => {
    if (/^\t/.test(line) || /^ +\t/.test(line)) {
      issues.push({
        line: index + 1,
        code: 'TAB_INDENT',
        message: 'Tab used for indentation; YAML requires spaces (usually 2).',
      })
    }
  })
  const stack = []
  let quote = null
  let quoteLine = 1
  let line = 1
  let index = 0
  while (index < source.length) {
    const char = source[index]
    if (char === '\n') {
      line += 1
      index += 1
      continue
    }
    if (quote !== null) {
      if (quote === '"' && char === '\\') {
        index += 2
        continue
      }
      if (char === quote) {
        if (quote === "'" && source[index + 1] === "'") {
          index += 2
          continue
        }
        quote = null
      }
      index += 1
      continue
    }
    if (char === '#') {
      while (index < source.length && source[index] !== '\n') index += 1
      continue
    }
    if (char === '"' || char === "'") {
      quote = char
      quoteLine = line
      index += 1
      continue
    }
    if (char === '[' || char === '{') {
      stack.push({ char, line })
      index += 1
      continue
    }
    if (char === ']' || char === '}') {
      const expected = char === ']' ? '[' : '{'
      const top = stack.pop()
      if (top === undefined || top.char !== expected) {
        issues.push({
          line,
          code: 'UNBALANCED_BRACKET',
          message: `Unexpected closing "${char}" without a matching "${expected}".`,
        })
      }
      index += 1
      continue
    }
    index += 1
  }
  if (quote !== null) {
    issues.push({ line: quoteLine, code: 'UNCLOSED_QUOTE', message: `Unclosed ${quote} quote.` })
  }
  for (const open of stack) {
    issues.push({ line: open.line, code: 'UNCLOSED_BRACKET', message: `Unclosed "${open.char}".` })
  }
  return { ok: issues.length === 0, issues: issues.slice(0, 50), scope: 'syntax-only' }
}

/**
 * Run Home Assistant's authoritative config check.
 * @returns {Promise<{ valid: boolean, result: string|null, errors: unknown, warnings: unknown, raw: unknown }>}
 */
async function runConfigCheck() {
  const raw = await checkConfig()
  const record = raw !== null && typeof raw === 'object' ? /** @type {Record<string, unknown>} */ (raw) : {}
  const rawResult = typeof raw === 'string' ? raw : String(record.result ?? '')
  const normalised = rawResult.toLowerCase()
  return {
    valid: normalised === 'valid',
    result: rawResult === '' ? null : rawResult,
    errors: record.errors ?? null,
    warnings: record.warnings ?? null,
    raw,
  }
}

/** Format a snapshot directory name: `<ts>-<label>`. */
function snapshotId(label) {
  const stamp = new Date().toISOString().replace(/[-:.]/g, '')
  const safeLabel = String(label ?? 'snapshot')
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
  return `${stamp}-${safeLabel === '' ? 'snapshot' : safeLabel}`
}

/** @param {string} file @param {string} content */
async function writeFileAtomic(file, content, mode = 0o644) {
  await mkdir(dirname(file), { recursive: true })
  const temp = `${file}.${randomBytes(4).toString('hex')}.tmp`
  try {
    await writeFile(temp, content, { encoding: 'utf8', mode, flag: 'wx' })
    await rename(temp, file)
  } catch (error) {
    await rm(temp, { force: true })
    throw error
  }
}

/**
 * Snapshot config files into `/data/config-backups/<id>/` with a manifest.
 * @param {string[]} paths config-relative paths (POSIX or native)
 * @param {{ label?: string, kind?: string, note?: string }} [options]
 * @returns {Promise<{ snapshot_id: string, dir: string, entries: object[], created_at: string }>}
 */
export async function snapshotConfigPaths(paths, options = {}) {
  if (!Array.isArray(paths) || paths.length === 0) {
    throw new ToolError('INVALID_ARGUMENT', 'paths must be a non-empty array of config-relative files.')
  }
  const { label = 'snapshot', kind = 'snapshot', note } = options
  const root = configRoot()
  const id = snapshotId(label)
  const backupsRoot = getPaths().configBackups
  let dir = join(backupsRoot, id)
  await mkdir(backupsRoot, { recursive: true })
  try {
    let attempt = 0
    while (attempt < 5) {
      try {
        await mkdir(dir)
        break
      } catch (error) {
        if (/** @type {NodeJS.ErrnoException} */ (error).code !== 'EEXIST' || attempt === 4) throw error
        attempt += 1
        dir = join(backupsRoot, `${id}-${randomBytes(2).toString('hex')}`)
      }
    }
  } catch (error) {
    throw new ToolError('INTERNAL', `Could not create the snapshot directory: ${error.message}`)
  }
  const entries = []
  for (const requested of paths) {
    const target = resolveConfigPath(requested)
    const rel = configRelative(target)
    const entry = { path: rel, existed: false }
    let buffer = null
    try {
      buffer = await readFile(target)
      entry.existed = true
      entry.sha256 = sha256(buffer)
      entry.bytes = buffer.length
      const destination = join(dir, 'files', ...rel.split('/'))
      await mkdir(dirname(destination), { recursive: true })
      await writeFile(destination, buffer)
    } catch (error) {
      const code = /** @type {NodeJS.ErrnoException} */ (error)?.code
      if (code !== 'ENOENT') throw fsError(error, rel)
    }
    entries.push(entry)
  }
  const createdAt = new Date().toISOString()
  const manifest = {
    schema_version: 1,
    id: basename(dir),
    label,
    kind,
    created_at: createdAt,
    config_dir: root,
    ...(note === undefined ? {} : { note }),
    entries,
  }
  await writeConfigManifest(dir, manifest)
  return { snapshot_id: basename(dir), dir, entries, created_at: createdAt }
}

/** @param {string} dir @param {object} manifest */
async function writeConfigManifest(dir, manifest) {
  const file = join(dir, 'manifest.json')
  await mkdir(dirname(file), { recursive: true })
  await writeFileAtomic(file, `${JSON.stringify(manifest, null, 2)}\n`, 0o600)
}

/**
 * List snapshots under the backup root (newest first).
 * @returns {Promise<object[]>}
 */
export async function listSnapshots() {
  const backupsRoot = getPaths().configBackups
  let dirents
  try {
    dirents = await readdir(backupsRoot, { withFileTypes: true })
  } catch (error) {
    if (/** @type {NodeJS.ErrnoException} */ (error)?.code === 'ENOENT') return []
    throw new ToolError('INTERNAL', `Could not list config snapshots: ${error.message}`)
  }
  const snapshots = []
  for (const dirent of dirents) {
    if (!dirent.isDirectory()) continue
    try {
      const manifest = JSON.parse(await readFile(join(backupsRoot, dirent.name, 'manifest.json'), 'utf8'))
      snapshots.push({
        snapshot_id: dirent.name,
        label: manifest.label ?? null,
        kind: manifest.kind ?? null,
        created_at: manifest.created_at ?? null,
        entries: Array.isArray(manifest.entries) ? manifest.entries.length : 0,
      })
    } catch {
      /* ignore unreadable snapshot folders */
    }
  }
  snapshots.sort((left, right) => String(right.created_at ?? '').localeCompare(String(left.created_at ?? '')))
  return snapshots
}

/**
 * Read one snapshot manifest.
 * @param {string} snapshotId
 * @returns {Promise<{ dir: string, manifest: object }>}
 */
async function readSnapshot(snapshotId) {
  if (typeof snapshotId !== 'string' || !/^[A-Za-z0-9._-]+$/.test(snapshotId) || snapshotId.includes('..')) {
    throw new ToolError('INVALID_ARGUMENT', 'snapshot_id is malformed.')
  }
  const dir = join(getPaths().configBackups, snapshotId)
  let manifest
  try {
    manifest = JSON.parse(await readFile(join(dir, 'manifest.json'), 'utf8'))
  } catch (error) {
    const code = /** @type {NodeJS.ErrnoException} */ (error)?.code
    if (code === 'ENOENT') {
      const available = await listSnapshots()
      throw new ToolError('NOT_FOUND', `No config snapshot with id ${snapshotId}.`, {
        hint:
          available.length === 0
            ? 'Create one with config_snapshot first.'
            : `Available snapshots: ${available.slice(0, 5).map((item) => item.snapshot_id).join(', ')}`,
      })
    }
    throw new ToolError('INTERNAL', `Snapshot ${snapshotId} has an unreadable manifest: ${error.message}`)
  }
  if (!Array.isArray(manifest.entries)) {
    throw new ToolError('INTERNAL', `Snapshot ${snapshotId} has an invalid manifest.`)
  }
  return { dir, manifest }
}

/**
 * Restore files from a snapshot, validating afterwards and rolling back on an
 * invalid configuration.
 * @param {{ snapshotId: string, path?: string, validate?: boolean }} options
 * @returns {Promise<object>}
 */
export async function restoreSnapshot(options) {
  const { snapshotId, path: onlyPath = undefined, validate = true } = options ?? {}
  const { dir, manifest } = await readSnapshot(snapshotId)
  let entries = manifest.entries
  if (onlyPath !== undefined) {
    const target = resolveConfigPath(onlyPath)
    const rel = configRelative(target)
    entries = entries.filter((entry) => entry.path === rel)
    if (entries.length === 0) {
      throw new ToolError('NOT_FOUND', `Snapshot ${snapshotId} does not contain ${rel}.`)
    }
  }
  /** @type {{ path: string, target: string, previous: string|null }[]} */
  const restorePlan = []
  for (const entry of entries) {
    const target = resolveConfigPath(entry.path)
    let previous = null
    try {
      previous = await readFile(target, 'utf8')
    } catch (error) {
      if (/** @type {NodeJS.ErrnoException} */ (error)?.code !== 'ENOENT') throw fsError(error, entry.path)
    }
    restorePlan.push({ path: entry.path, target, previous })
  }
  const warnings = []
  // Snapshot the current state first, so a restore is itself reversible on disk.
  let preRestoreSnapshotId = null
  try {
    const preRestore = await snapshotConfigPaths(
      restorePlan.map((item) => item.path),
      { label: 'pre-restore', kind: 'pre-restore', note: `before restoring ${snapshotId}` },
    )
    preRestoreSnapshotId = preRestore.snapshot_id
  } catch {
    warnings.push({
      code: 'SNAPSHOT_FAILED',
      message: 'Could not write a pre-restore snapshot; rollback still uses in-memory copies of the current files.',
    })
  }
  const restored = []
  for (const entry of entries) {
    const target = resolveConfigPath(entry.path)
    if (entry.existed === true) {
      const source = join(dir, 'files', ...entry.path.split('/'))
      let content
      try {
        content = await readFile(source)
      } catch (error) {
        throw fsError(error, `snapshot ${snapshotId} file ${entry.path}`)
      }
      await writeFileAtomic(target, content, 0o644)
      restored.push({ path: entry.path, action: 'restored', bytes: content.length })
    } else {
      await rm(target, { force: true })
      restored.push({ path: entry.path, action: 'removed', bytes: 0 })
    }
  }
  let validation = { checked: false }
  if (validate !== false) {
    try {
      validation = { checked: true, source: 'POST /api/config/core/check_config', ...(await runConfigCheck()) }
    } catch (error) {
      if (!(error instanceof ToolError)) throw error
      const restoredText = restored.some((item) => /\.ya?ml$/i.test(item.path))
      if (restoredText) {
        // Home Assistant is unreachable; fall back to a syntax-only sanity check.
        for (const entry of entries) {
          if (entry.existed !== true) continue
          const content = await readFile(join(dir, 'files', ...entry.path.split('/')), 'utf8')
          const sanity = yamlSanityCheck(content)
          if (!sanity.ok) {
            await rollbackRestore(restorePlan)
            throw new ToolError('INVALID_ARGUMENT', 'The restored configuration failed YAML sanity checks and was rolled back.', {
              hint: 'Home Assistant could not validate (it may be down); inspect the snapshot before retrying.',
              data: { snapshot_id: snapshotId, rolled_back: true, sanity, reason: error.message },
            })
          }
        }
        validation = { checked: false, fallback: 'yaml-syntax-only', reason: error.message }
        warnings.push({
          code: 'VALIDATION_FALLBACK',
          message: 'Home Assistant could not validate the restore; only YAML syntax was checked.',
        })
      } else {
        validation = { checked: false, reason: error.message }
      }
    }
    if (validation.checked === true && validation.valid === false) {
      await rollbackRestore(restorePlan)
      const available = await listSnapshots()
      throw new ToolError(
        'INVALID_ARGUMENT',
        'The restored configuration is invalid, so the restore was rolled back.',
        {
          hint: `Inspect the snapshot or pick another one. Available: ${
            available.slice(0, 5).map((item) => item.snapshot_id).join(', ') || 'none'
          }`,
          data: {
            snapshot_id: snapshotId,
            rolled_back: true,
            validation,
            restored,
          },
        },
      )
    }
  }
  return { snapshot_id: snapshotId, pre_restore_snapshot_id: preRestoreSnapshotId, restored, validation, warnings }
}

/**
 * Undo an in-progress restore using the pre-read file contents.
 * @param {{ path: string, target: string, previous: string|null }[]} plan
 */
async function rollbackRestore(plan) {
  for (const item of plan) {
    if (item.previous === null) {
      await rm(item.target, { force: true })
    } else {
      await writeFileAtomic(item.target, item.previous, 0o644)
    }
  }
}

/**
 * Create a pre-change snapshot, write a file atomically, validate and roll back
 * on failure.
 * @param {{ path: string, content: string, baseSha256?: string, snapshot?: boolean, validate?: boolean, label?: string, note?: string }} options
 * @returns {Promise<object>}
 */
export async function writeConfigFile(options) {
  const {
    path,
    content,
    baseSha256 = undefined,
    snapshot = true,
    validate = true,
    label = 'write',
    note = undefined,
  } = options ?? {}
  if (typeof path !== 'string' || path.trim() === '') {
    throw new ToolError('INVALID_ARGUMENT', 'path is required.')
  }
  if (typeof content !== 'string') throw new ToolError('INVALID_ARGUMENT', 'content must be a string.')
  const target = resolveConfigPath(path)
  const rel = configRelative(target)
  guardSecretFile(rel, 'write')
  let previous = null
  try {
    const buffer = await readFile(target)
    if (buffer.includes(0)) throw new ToolError('FORBIDDEN', `Refusing to overwrite binary file: ${rel}`)
    previous = buffer.toString('utf8')
  } catch (error) {
    if (error instanceof ToolError) throw error
    if (/** @type {NodeJS.ErrnoException} */ (error)?.code !== 'ENOENT') throw fsError(error, rel)
  }
  if (previous !== null) {
    const currentSha = sha256(previous)
    if (typeof baseSha256 !== 'string' || baseSha256 === '') {
      throw new ToolError('CONFLICT', `base_sha256 is required to overwrite an existing file: ${rel}`, {
        hint: `Call config_read first and pass its sha256 (${currentSha}) as base_sha256.`,
        data: { path: rel, current_sha256: currentSha, reason: 'READ_BEFORE_WRITE' },
      })
    }
    if (baseSha256 !== currentSha) {
      throw new ToolError('CONFLICT', `STALE_BASE: ${rel} changed since it was read.`, {
        hint: 'Read the file again, re-apply the intended change to the current content, then write with the new sha256.',
        data: { path: rel, current_sha256: currentSha, provided_sha256: baseSha256, reason: 'STALE_BASE' },
      })
    }
  }
  let snapshotResult = null
  if (snapshot !== false) {
    snapshotResult = await snapshotConfigPaths([rel], { label, kind: 'pre-write', ...(note === undefined ? {} : { note }) })
  }
  try {
    await writeFileAtomic(target, content, 0o644)
  } catch (error) {
    throw fsError(error, rel)
  }
  const diff = diffLines(previous ?? '', content)
  const result = {
    path: rel,
    created: previous === null,
    bytes: Buffer.byteLength(content, 'utf8'),
    sha256: sha256(content),
    snapshot_id: snapshotResult === null ? null : snapshotResult.snapshot_id,
    diff,
    validation: { checked: false },
    warnings: [],
  }
  if (validate !== false) {
    try {
      result.validation = { checked: true, source: 'POST /api/config/core/check_config', ...(await runConfigCheck()) }
    } catch (error) {
      if (!(error instanceof ToolError)) {
        await rollbackWrite(target, previous)
        throw error
      }
      const yaml = /\.ya?ml$/i.test(rel)
      if (yaml) {
        const sanity = yamlSanityCheck(content)
        if (!sanity.ok) {
          await rollbackWrite(target, previous)
          throw new ToolError('INVALID_ARGUMENT', 'The file failed YAML sanity checks and the change was rolled back.', {
            hint: 'Home Assistant is unreachable, so only syntax was checked. Fix the reported issues and retry.',
            data: {
              path: rel,
              rolled_back: true,
              snapshot_id: snapshotResult === null ? null : snapshotResult.snapshot_id,
              sanity,
              reason: error.message,
            },
          })
        }
        result.validation = { checked: false, fallback: 'yaml-syntax-only', sanity, reason: error.message }
        result.warnings.push({
          code: 'VALIDATION_FALLBACK',
          message: 'Home Assistant could not validate the file; only YAML syntax was checked.',
        })
      } else {
        result.validation = { checked: false, reason: error.message }
        result.warnings.push({
          code: 'VALIDATION_UNAVAILABLE',
          message: 'Home Assistant could not run the configuration check for this file.',
        })
      }
    }
    if (result.validation.checked === true && result.validation.valid === false) {
      await rollbackWrite(target, previous)
      throw new ToolError('INVALID_ARGUMENT', `The configuration check failed; ${rel} was rolled back.`, {
        hint: 'Read the check errors, fix the YAML, and write again. The previous content is restored.',
        data: {
          path: rel,
          rolled_back: true,
          snapshot_id: snapshotResult === null ? null : snapshotResult.snapshot_id,
          validation: result.validation,
          diff,
        },
      })
    }
  }
  return result
}

/**
 * Replace one unique occurrence of `old_string` with `new_string`.
 * @param {{ path: string, oldString: string, newString: string, baseSha256?: string, validate?: boolean, replaceAll?: boolean }} options
 * @returns {Promise<object>}
 */
export async function editConfigFile(options) {
  const {
    path,
    oldString,
    newString,
    baseSha256 = undefined,
    validate = true,
    replaceAll = false,
  } = options ?? {}
  if (typeof oldString !== 'string' || oldString === '') {
    throw new ToolError('INVALID_ARGUMENT', 'old_string must be a non-empty string.')
  }
  if (typeof newString !== 'string') throw new ToolError('INVALID_ARGUMENT', 'new_string must be a string.')
  const target = resolveConfigPath(path)
  const rel = configRelative(target)
  guardSecretFile(rel, 'edit')
  let previous
  try {
    const buffer = await readFile(target)
    if (buffer.includes(0)) throw new ToolError('FORBIDDEN', `Refusing to edit binary file: ${rel}`)
    previous = buffer.toString('utf8')
  } catch (error) {
    if (error instanceof ToolError) throw error
    throw fsError(error, rel)
  }
  const currentSha = sha256(previous)
  if (typeof baseSha256 !== 'string' || baseSha256 === '') {
    throw new ToolError('CONFLICT', `base_sha256 is required to edit ${rel}.`, {
      hint: `Call config_read first and pass its sha256 (${currentSha}).`,
      data: { path: rel, current_sha256: currentSha, reason: 'READ_BEFORE_WRITE' },
    })
  }
  if (baseSha256 !== currentSha) {
    throw new ToolError('CONFLICT', `STALE_BASE: ${rel} changed since it was read.`, {
      hint: 'Read the file again and re-apply the edit to the current content.',
      data: { path: rel, current_sha256: currentSha, provided_sha256: baseSha256, reason: 'STALE_BASE' },
    })
  }
  const occurrences = previous.split(oldString).length - 1
  if (occurrences === 0) {
    throw new ToolError('NOT_FOUND', `old_string was not found in ${rel}.`, {
      hint: 'Read the current file and copy the exact text, including whitespace.',
    })
  }
  if (occurrences > 1 && replaceAll !== true) {
    throw new ToolError('INVALID_ARGUMENT', `old_string occurs ${occurrences} times in ${rel}.`, {
      hint: 'Include more surrounding text to make the match unique, or pass replace_all=true.',
    })
  }
  const content = replaceAll === true ? previous.split(oldString).join(newString) : previous.replace(oldString, newString)
  const written = await writeConfigFile({
    path: rel,
    content,
    baseSha256: currentSha,
    validate,
    label: 'edit',
    note: `targeted edit of ${rel}`,
  })
  return {
    ...written,
    replacements: replaceAll === true ? occurrences : 1,
    old_string_sha256: sha256(oldString),
  }
}

/**
 * Delete one config file after snapshotting it.
 * @param {{ path: string, baseSha256?: string, snapshot?: boolean, allowCoreFiles?: boolean }} options
 * @returns {Promise<object>}
 */
export async function deleteConfigFile(options) {
  const { path, baseSha256 = undefined, snapshot = true, allowCoreFiles = false } = options ?? {}
  const target = resolveConfigPath(path)
  const rel = configRelative(target)
  if (isCoreConfigFile(rel) && allowCoreFiles !== true) {
    throw new ToolError('FORBIDDEN', `Refusing to delete core config file ${rel} without allow_core_files=true.`, {
      hint: 'Core configuration files should be edited, not deleted. Set allow_core_files=true only for a deliberate replacement.',
    })
  }
  let previous
  try {
    const buffer = await readFile(target)
    if (buffer.includes(0)) throw new ToolError('FORBIDDEN', `Refusing to delete binary file: ${rel}`)
    previous = buffer.toString('utf8')
  } catch (error) {
    if (error instanceof ToolError) throw error
    throw fsError(error, rel)
  }
  const currentSha = sha256(previous)
  if (typeof baseSha256 !== 'string' || baseSha256 === '') {
    throw new ToolError('CONFLICT', `base_sha256 is required to delete ${rel}.`, {
      hint: `Call config_read first and pass its sha256 (${currentSha}).`,
      data: { path: rel, current_sha256: currentSha, reason: 'READ_BEFORE_WRITE' },
    })
  }
  if (baseSha256 !== currentSha) {
    throw new ToolError('CONFLICT', `STALE_BASE: ${rel} changed since it was read.`, {
      hint: 'Read the file again before deleting it.',
      data: { path: rel, current_sha256: currentSha, provided_sha256: baseSha256, reason: 'STALE_BASE' },
    })
  }
  if (snapshot === false) {
    throw new ToolError('FORBIDDEN', 'A snapshot is required for config_delete; snapshot=false is not supported.', {
      hint: 'Delete is destructive: keep snapshot=true so the file can be restored.',
    })
  }
  const snapshotResult = await snapshotConfigPaths([rel], { label: 'delete', kind: 'pre-delete', note: `delete ${rel}` })
  try {
    await unlink(target)
  } catch (error) {
    throw fsError(error, rel)
  }
  return {
    path: rel,
    deleted: true,
    bytes: Buffer.byteLength(previous, 'utf8'),
    was_core_file: isCoreConfigFile(rel),
    snapshot_id: snapshotResult.snapshot_id,
    restore_with: `config_restore snapshot_id=${snapshotResult.snapshot_id} path=${rel}`,
  }
}

/** @param {string} target @param {string|null} previous */
async function rollbackWrite(target, previous) {
  if (previous === null) {
    await rm(target, { force: true })
  } else {
    await writeFileAtomic(target, previous, 0o644)
  }
}

/**
 * Validate one YAML snippet with Home Assistant when reachable, otherwise with
 * the local syntax-only fallback. Used by templates/automation tools.
 * @param {string} text
 * @returns {Promise<{ checked: boolean, valid: boolean|null, source: string, sanity: object|null }>}
 */
export async function validateYamlSnippet(text) {
  try {
    const check = await runConfigCheck()
    return { checked: true, valid: check.valid, source: 'POST /api/config/core/check_config', sanity: null }
  } catch (error) {
    if (!(error instanceof ToolError)) throw error
    return {
      checked: false,
      valid: null,
      source: 'yaml-syntax-only',
      sanity: yamlSanityCheck(text),
      reason: error.message,
    }
  }
}
