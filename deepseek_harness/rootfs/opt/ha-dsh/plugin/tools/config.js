/**
 * Configuration filesystem tools (`config_*`).
 *
 * Every read and write goes through `lib/config-files.js`, which enforces the
 * deny-lists, snapshots before changes, checks `base_sha256` (read-before-write)
 * and validates through Home Assistant's config check with rollback on failure.
 * Delete and restore are confirmation-token gated.
 *
 * @module plugin/tools/config
 */

import {
  configRelative,
  deleteConfigFile,
  editConfigFile,
  listConfig,
  listSnapshots,
  readConfigFile,
  resolveConfigPath,
  restoreSnapshot,
  searchConfig,
  snapshotConfigPaths,
  writeConfigFile,
} from '../../lib/config-files.js'
import { classify, consumeApproval, isCoreConfigFile, needsApproval } from '../../lib/safety.js'
import { fail, ok, renderJson, toErrorResult } from '../../lib/result.js'

/** Output schema shared by every tool (canonical envelope). */
const OBJECT_SCHEMA = { type: 'object', additionalProperties: true }

/**
 * Build one tool definition.
 * @param {string} name
 * @param {string} description
 * @param {object} parameters JSON Schema
 * @param {(args: Record<string, any>) => Promise<object>} execute
 * @returns {object}
 */
function defineTool(name, description, parameters, execute) {
  return {
    name,
    description,
    parameters,
    output: { schema: OBJECT_SCHEMA, render: renderJson },
    xClass: classify(name),
    execute,
  }
}

/** Wrap a tool body so raw errors never escape. */
function guarded(body) {
  return async (args = {}) => {
    const sources = []
    try {
      return await body(args, sources)
    } catch (error) {
      return toErrorResult(/** @type {Error} */ (error), sources)
    }
  }
}

/** Snapshot summary for a result envelope. */
function snapshotMeta(result) {
  return {
    snapshot_id: result?.snapshot_id ?? null,
    entries: result?.entries ?? [],
  }
}

const tools = [
  defineTool(
    'config_list',
    'List files and directories under the Home Assistant config directory.',
    {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Config-relative directory; defaults to "/".' },
        depth: { type: 'number', description: 'How many directory levels to descend (default 2).' },
        include_hidden: { type: 'boolean', description: 'Include dotfiles (default false).' },
        limit: { type: 'number', description: 'Max entries (default 500).' },
      },
      additionalProperties: false,
    },
    guarded(async (args, sources) => {
      const data = await listConfig({
        path: args.path ?? '.',
        depth: Math.min(6, Math.max(1, Number(args.depth ?? 2))),
        includeHidden: args.include_hidden === true,
        limit: Math.min(2000, Math.max(1, Number(args.limit ?? 500))),
      })
      sources.push(`filesystem /config${data.path === '/' ? '' : `/${data.path}`}`)
      return ok(`${data.count} entries under ${data.path}`, data, {
        source: sources,
        truncated: data.truncated,
      })
    }),
  ),

  defineTool(
    'config_read',
    'Read one config file with its SHA-256 base (required for later writes).',
    {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Config-relative file path.' },
        max_bytes: { type: 'number', description: 'Max characters of content to return (default 65536).' },
        start_line: { type: 'number', description: 'First line to return (1-based).' },
        end_line: { type: 'number', description: 'Last line to return (1-based).' },
      },
      required: ['path'],
      additionalProperties: false,
    },
    guarded(async (args, sources) => {
      const data = await readConfigFile({
        path: args.path,
        maxBytes: Math.min(1_048_576, Math.max(1, Number(args.max_bytes ?? 65_536))),
        startLine: args.start_line === undefined ? undefined : Number(args.start_line),
        endLine: args.end_line === undefined ? undefined : Number(args.end_line),
      })
      sources.push(`filesystem /config/${data.path}`)
      return ok(`${data.path} (${data.line_count} lines)`, data, {
        source: sources,
        truncated: data.truncated,
      })
    }),
  ),

  defineTool(
    'config_search',
    'Search config files with a regular expression (grep-like, bounded).',
    {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Regular expression to match per line.' },
        glob: { type: 'string', description: 'File glob, e.g. "*.yaml" (default) or "**/*.json".' },
        path: { type: 'string', description: 'Config-relative directory to search (default "/").' },
        max_results: { type: 'number', description: 'Max matches (default 50).' },
        ignore_case: { type: 'boolean', description: 'Case-insensitive (default true).' },
      },
      required: ['query'],
      additionalProperties: false,
    },
    guarded(async (args, sources) => {
      const data = await searchConfig({
        query: args.query,
        glob: args.glob ?? '*.yaml',
        path: args.path ?? '.',
        maxResults: Math.min(500, Math.max(1, Number(args.max_results ?? 50))),
        ignoreCase: args.ignore_case !== false,
      })
      sources.push(`filesystem /config${data.path === '/' ? '' : `/${data.path}`}`)
      return ok(`${data.matches.length} matches in ${data.files_searched} files`, data, {
        source: sources,
        truncated: data.truncated,
      })
    }),
  ),

  defineTool(
    'config_write',
    'Write a config file atomically with a pre-write snapshot and config-check rollback.',
    {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Config-relative file path.' },
        content: { type: 'string', description: 'Full new file content.' },
        base_sha256: {
          type: 'string',
          description: 'SHA-256 from config_read; required when the file already exists.',
        },
        snapshot: { type: 'boolean', description: 'Snapshot the previous file first (default true).' },
        validate: { type: 'boolean', description: 'Run the Home Assistant config check and roll back on failure (default true).' },
        label: { type: 'string', description: 'Snapshot label, e.g. "automation-edit".' },
      },
      required: ['path', 'content'],
      additionalProperties: false,
    },
    guarded(async (args, sources) => {
      const result = await writeConfigFile({
        path: args.path,
        content: args.content,
        baseSha256: args.base_sha256,
        snapshot: args.snapshot !== false,
        validate: args.validate !== false,
        label: typeof args.label === 'string' && args.label !== '' ? args.label : 'write',
      })
      sources.push(`filesystem /config/${result.path}`)
      if (result.validation?.checked === true) sources.push('POST /api/config/core/check_config')
      return ok(`${result.created ? 'Created' : 'Updated'} ${result.path} (${result.bytes} bytes)`, {
        path: result.path,
        created: result.created,
        bytes: result.bytes,
        sha256: result.sha256,
        diff: result.diff,
        validation: result.validation,
        snapshot_id: result.snapshot_id,
        restore_with: `config_restore snapshot_id=${result.snapshot_id}`,
      }, { source: sources, warnings: result.warnings })
    }),
  ),

  defineTool(
    'config_edit',
    'Replace one unique string in a config file, with snapshot and config-check rollback.',
    {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Config-relative file path.' },
        old_string: { type: 'string', description: 'Exact text to replace (must be unique unless replace_all).' },
        new_string: { type: 'string', description: 'Replacement text.' },
        base_sha256: { type: 'string', description: 'SHA-256 from config_read (required).' },
        validate: { type: 'boolean', description: 'Run the config check and roll back on failure (default true).' },
        replace_all: { type: 'boolean', description: 'Replace every occurrence (default false).' },
      },
      required: ['path', 'old_string', 'new_string', 'base_sha256'],
      additionalProperties: false,
    },
    guarded(async (args, sources) => {
      const result = await editConfigFile({
        path: args.path,
        oldString: args.old_string,
        newString: args.new_string,
        baseSha256: args.base_sha256,
        validate: args.validate !== false,
        replaceAll: args.replace_all === true,
      })
      sources.push(`filesystem /config/${result.path}`)
      if (result.validation?.checked === true) sources.push('POST /api/config/core/check_config')
      return ok(`Edited ${result.path} (${result.replacements} replacement(s))`, {
        path: result.path,
        replacements: result.replacements,
        bytes: result.bytes,
        sha256: result.sha256,
        diff: result.diff,
        validation: result.validation,
        snapshot_id: result.snapshot_id,
        restore_with: `config_restore snapshot_id=${result.snapshot_id}`,
      }, { source: sources, warnings: result.warnings })
    }),
  ),

  defineTool(
    'config_delete',
    'Delete a config file after snapshotting it (destructive; confirmation token required).',
    {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Config-relative file path.' },
        base_sha256: { type: 'string', description: 'SHA-256 from config_read (required).' },
        allow_core_files: {
          type: 'boolean',
          description: 'Required to delete configuration.yaml/automations.yaml/scripts.yaml/scenes.yaml and friends (default false).',
        },
        confirmation_token: { type: 'string', description: 'Token from a previous NEEDS_APPROVAL result.' },
      },
      required: ['path', 'base_sha256'],
      additionalProperties: false,
    },
    guarded(async (args, sources) => {
      const target = resolveConfigPath(args.path)
      const rel = configRelative(target)
      const core = isCoreConfigFile(rel)
      if (core && args.allow_core_files !== true) {
        return fail('FORBIDDEN', `Refusing to delete core config file ${rel} without allow_core_files=true.`, {
          hint: 'Edit or snapshot the file instead; deleting core files is destructive. Set allow_core_files only for a deliberate replacement.',
        })
      }
      if (args.confirmation_token === undefined) {
        let facts = { path: rel, core_file: core }
        try {
          const current = await readConfigFile({ path: rel, maxBytes: 1 })
          facts = { ...facts, current_sha256: current.sha256, bytes: current.bytes }
        } catch {
          /* the plan can still describe the intended delete */
        }
        return needsApproval('config_delete', args, {
          action: `Delete config file ${rel}`,
          target: rel,
          impact: core
            ? 'A core Home Assistant configuration file is deleted. Related automations/scripts/scenes or core setup will stop working.'
            : 'The file is removed from /config. Everything that includes it stops working.',
          rollback: 'The file is snapshotted first and can be restored with config_restore.',
          backup: { available: true, suggestion: 'The pre-delete snapshot is created automatically.' },
          facts,
        })
      }
      consumeApproval('config_delete', args)
      const result = await deleteConfigFile({
        path: rel,
        baseSha256: args.base_sha256,
        snapshot: true,
        allowCoreFiles: args.allow_core_files === true,
      })
      sources.push(`filesystem /config/${rel}`)
      return ok(`Deleted ${rel} (snapshot ${result.snapshot_id})`, result, { source: sources })
    }),
  ),

  defineTool(
    'config_snapshot',
    'Snapshot config files under /data/config-backups with a manifest.',
    {
      type: 'object',
      properties: {
        paths: {
          type: 'array',
          items: { type: 'string' },
          description: 'Config-relative files to snapshot (at least one).',
        },
        label: { type: 'string', description: 'Short label, e.g. "before-automation-edit".' },
        note: { type: 'string', description: 'Optional human note stored in the manifest.' },
      },
      required: ['paths'],
      additionalProperties: false,
    },
    guarded(async (args, sources) => {
      const result = await snapshotConfigPaths(args.paths, {
        label: typeof args.label === 'string' && args.label !== '' ? args.label : 'snapshot',
        kind: 'manual',
        note: typeof args.note === 'string' ? args.note : undefined,
      })
      sources.push(`filesystem ${result.dir}`)
      return ok(`Snapshot ${result.snapshot_id} (${result.entries.length} file(s))`, {
        snapshot_id: result.snapshot_id,
        created_at: result.created_at,
        ...snapshotMeta(result),
      }, { source: sources })
    }),
  ),

  defineTool(
    'config_restore',
    'Restore config files from a snapshot (confirmation token required).',
    {
      type: 'object',
      properties: {
        snapshot_id: { type: 'string', description: 'Snapshot id from config_snapshot/config_write.' },
        path: {
          type: 'string',
          description: 'Restore only this config-relative file from the snapshot (default: all files).',
        },
        confirmation_token: { type: 'string', description: 'Token from a previous NEEDS_APPROVAL result.' },
      },
      required: ['snapshot_id'],
      additionalProperties: false,
    },
    guarded(async (args, sources) => {
      const snapshotId = String(args.snapshot_id ?? '')
      if (snapshotId === '') return fail('INVALID_ARGUMENT', 'snapshot_id is required.')
      if (args.confirmation_token === undefined) {
        const snapshots = await listSnapshots()
        const snapshot = snapshots.find((item) => item.snapshot_id === snapshotId)
        if (snapshot === undefined) {
          return fail('NOT_FOUND', `No config snapshot with id ${snapshotId}.`, {
            hint:
              snapshots.length === 0
                ? 'Create one with config_snapshot first.'
                : `Available: ${snapshots.slice(0, 5).map((item) => item.snapshot_id).join(', ')}`,
          })
        }
        return needsApproval('config_restore', args, {
          action: `Restore config snapshot ${snapshotId}`,
          target: typeof args.path === 'string' ? args.path : 'all files in the snapshot',
          impact: 'The current content of the affected config files is overwritten by the snapshot content.',
          rollback:
            'The current content is re-snapshotted before restoring and is put back automatically if the config check fails.',
          backup: { available: true, suggestion: 'A pre-restore snapshot is created automatically.' },
          facts: {
            snapshot_id: snapshotId,
            label: snapshot.label ?? null,
            created_at: snapshot.created_at ?? null,
            entries: snapshot.entries,
            path: typeof args.path === 'string' ? args.path : null,
          },
        })
      }
      consumeApproval('config_restore', args)
      const result = await restoreSnapshot({
        snapshotId,
        path: typeof args.path === 'string' && args.path !== '' ? args.path : undefined,
        validate: true,
      })
      sources.push(`filesystem /data/config-backups/${snapshotId}`)
      if (result.validation?.checked === true) sources.push('POST /api/config/core/check_config')
      return ok(`Restored ${result.restored.length} file(s) from ${snapshotId}`, result, {
        source: sources,
        warnings: result.warnings,
      })
    }),
  ),
]

export { tools }
export default tools
