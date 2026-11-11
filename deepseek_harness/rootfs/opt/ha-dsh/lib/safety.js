/**
 * Operation classes, capability gates, deny-lists and the dry-run confirmation
 * protocol shared by every mutating tool.
 *
 * The plugin cannot rely on Home Assistant to enforce least privilege: the
 * Supervisor proxy always acts as an HA administrator. Read-only and approval
 * behaviour is therefore enforced here, before any request leaves the add-on.
 *
 * @module safety
 */

import { getOptions } from './paths.js'
import { ToolError, sha256, stableStringify, randomToken } from './result.js'

/** Operation classes. @enum {string} */
export const CLASS = Object.freeze({
  READ: 'R',
  SAFE_WRITE: 'SW',
  ACT: 'ACT',
  DISRUPTIVE: 'DIS',
  DESTRUCTIVE: 'DES',
})

/** Tools that stay available in `read_only` mode (R plus safe /data-only writes). */
const READ_ONLY_ALLOWED = new Set([
  'config_snapshot',
  'memory_update',
  'monitor_probe',
])

/** Every tool name and its class. Unknown names default to ACT (fail-safe). */
export const TOOL_CLASSES = Object.freeze({
  // Home Assistant Core reads
  ha_get_config: CLASS.READ,
  ha_get_states: CLASS.READ,
  ha_get_state: CLASS.READ,
  ha_get_services: CLASS.READ,
  ha_get_history: CLASS.READ,
  ha_get_logbook: CLASS.READ,
  ha_get_error_log: CLASS.READ,
  ha_get_config_check: CLASS.READ,
  ha_render_template: CLASS.READ,
  ha_list_automations: CLASS.READ,
  ha_list_registry: CLASS.READ,
  ha_get_repairs: CLASS.READ,
  ha_get_system_log: CLASS.READ,
  ha_get_automation_trace: CLASS.READ,
  ha_compat_scan: CLASS.READ,
  ha_recommend: CLASS.READ,
  ha_get_dashboard: CLASS.READ,
  ha_save_dashboard: CLASS.SAFE_WRITE,
  // WebSocket-backed diagnostics are covered above.

  // Home Assistant Core actions
  ha_call_service: CLASS.ACT,
  ha_reload: CLASS.ACT,
  ha_restart: CLASS.DISRUPTIVE,

  // Supervisor / system reads
  sup_get_info: CLASS.READ,
  sup_get_resolution: CLASS.READ,
  sup_get_updates: CLASS.READ,
  sup_list_addons: CLASS.READ,
  sup_get_addon: CLASS.READ,
  sup_addon_logs: CLASS.READ,
  sup_get_store: CLASS.READ,
  sup_get_logs: CLASS.READ,
  sup_backup_list: CLASS.READ,
  sup_backup_info: CLASS.READ,
  sup_job_status: CLASS.READ,

  // Supervisor writes
  sup_store_reload: CLASS.SAFE_WRITE,
  sup_set_addon_options: CLASS.SAFE_WRITE,
  sup_backup_create: CLASS.SAFE_WRITE,
  sup_addon_start: CLASS.ACT,
  sup_addon_stop: CLASS.ACT,
  sup_addon_restart: CLASS.ACT,
  sup_addon_install: CLASS.DISRUPTIVE,
  sup_addon_update: CLASS.DISRUPTIVE,
  sup_addon_rebuild: CLASS.DISRUPTIVE,
  sup_core_update: CLASS.DISRUPTIVE,
  sup_addon_uninstall: CLASS.DESTRUCTIVE,
  sup_backup_restore: CLASS.DESTRUCTIVE,

  // Config filesystem
  config_list: CLASS.READ,
  config_read: CLASS.READ,
  config_search: CLASS.READ,
  config_write: CLASS.SAFE_WRITE,
  config_edit: CLASS.SAFE_WRITE,
  config_snapshot: CLASS.SAFE_WRITE,
  config_restore: CLASS.SAFE_WRITE,
  config_delete: CLASS.DESTRUCTIVE,

  // Memory / monitoring / knowledge
  memory_get: CLASS.READ,
  memory_refresh: CLASS.READ,
  memory_update: CLASS.SAFE_WRITE,
  monitor_probe: CLASS.READ,
  monitor_history: CLASS.READ,
  monitor_configure: CLASS.SAFE_WRITE,
  monitor_digest: CLASS.ACT,
  notify_user: CLASS.ACT,
  ha_news_scan: CLASS.READ,
  ha_news_digest: CLASS.READ,
  knowledge_search: CLASS.READ,

  // Add-on builder
  addon_scaffold: CLASS.SAFE_WRITE,
  addon_validate: CLASS.READ,
  addon_build: CLASS.DISRUPTIVE,
})

/** @param {string} toolName @returns {string} */
export function classify(toolName) {
  return TOOL_CLASSES[toolName] ?? CLASS.ACT
}

/** @returns {'R'|'SW'|'ACT'|'DIS'|'DES'} */
export function classOf(toolName) {
  return classify(toolName)
}

/** True when the add-on options put the plugin in read-only mode. */
export function readOnly() {
  return getOptions().readOnly
}

/** True when restarting Home Assistant Core is allowed by options. */
export function canRestart() {
  return !readOnly() && getOptions().allowRestarts
}

/** True when add-on lifecycle management is allowed by options. */
export function canManageAddons() {
  return !readOnly() && getOptions().allowAddonManagement
}

/**
 * Filter tool definitions for the active capability mode. Tool modules attach
 * `xClass` to each definition; the registry receives definitions without it.
 * @template {{ name: string, xClass?: string }} T
 * @param {T[]} definitions
 * @param {{ readOnly?: boolean }} [mode]
 * @returns {T[]}
 */
export function filterTools(definitions, mode = {}) {
  const readonly = mode.readOnly ?? readOnly()
  if (!readonly) return definitions
  return definitions.filter((definition) => {
    const kind = definition.xClass ?? classify(definition.name)
    return kind === CLASS.READ || READ_ONLY_ALLOWED.has(definition.name)
  })
}

/** Service domains that must never be called through `ha_call_service`. */
const DENIED_DOMAINS = new Map([
  ['shell_command', 'Arbitrary command execution is not allowed through service calls.'],
  ['python_script', 'Arbitrary Python execution is not allowed through service calls.'],
  ['pyscript', 'Arbitrary Python execution is not allowed through service calls.'],
  ['hassio', 'Use the dedicated sup_* tools instead of the hassio service domain.'],
])

/**
 * Check whether a service call is allowed at all (before approval).
 * @param {string} domain @param {string} service
 * @returns {{ allowed: boolean, reason?: string, safetyDomain?: boolean }}
 */
export function checkService(domain, service) {
  if (DENIED_DOMAINS.has(domain)) {
    return { allowed: false, reason: DENIED_DOMAINS.get(domain) }
  }
  if (domain === 'homeassistant' && ['restart', 'stop', 'reload_all', 'reload_core_config'].includes(service)) {
    if (service === 'restart' || service === 'stop') {
      return { allowed: true, safetyDomain: true }
    }
    return { allowed: true }
  }
  const safetyDomain = ['lock', 'alarm_control_panel', 'valve', 'siren', 'camera'].includes(domain)
  return { allowed: true, safetyDomain }
}

/** Paths the config tools must never touch. */
export const DENY_CONFIG_PATHS = Object.freeze([
  '.storage',
  'deps',
  'tts',
  '.cloud',
  '.git',
  'home-assistant.log',
  'home-assistant_v2.db',
  'home-assistant_v2.db-wal',
  'home-assistant_v2.db-shm',
])

/** Config files whose deletion/overwrite needs extra care. */
export const CORE_CONFIG_FILES = Object.freeze([
  'configuration.yaml',
  'secrets.yaml',
  'automations.yaml',
  'scripts.yaml',
  'scenes.yaml',
  'groups.yaml',
  'customize.yaml',
])

/**
 * Reject a config-relative path that is absolute, escapes the config dir, or
 * targets a denied subtree.
 * @param {string} relative path relative to the HA config directory
 * @returns {string} normalised POSIX-style relative path
 */
export function assertSafeConfigPath(relative) {
  if (typeof relative !== 'string' || relative.trim() === '') {
    throw new ToolError('INVALID_ARGUMENT', 'A config-relative path is required.')
  }
  const normalised = relative.replaceAll('\\', '/').replace(/^\/+/, '')
  const segments = normalised.split('/')
  if (segments.some((segment) => segment === '..' || segment === '.')) {
    throw new ToolError('FORBIDDEN', `Path traversal is not allowed: ${relative}`)
  }
  if (segments.some((segment) => DENY_CONFIG_PATHS.includes(segment))) {
    throw new ToolError('FORBIDDEN', `This path is managed by Home Assistant and cannot be read or written: ${relative}`, {
      hint: 'Use the Home Assistant UI or the configuration API instead.',
    })
  }
  if (/\.(db|db-wal|db-shm|sqlite|sqlite3)$/i.test(normalised)) {
    throw new ToolError('FORBIDDEN', `Database files cannot be accessed: ${relative}`)
  }
  return segments.join('/')
}

/** Whether a config-relative path is one of the core files. */
export function isCoreConfigFile(relative) {
  const base = relative.replaceAll('\\', '/').split('/').at(-1) ?? ''
  return CORE_CONFIG_FILES.includes(base)
}

/**
 * Confirmation store for DIS/DES tools: token → binding.
 * @type {Map<string, { toolName: string, argsHash: string, expiresAt: number, plan: object }>}
 */
const pendingConfirmations = new Map()

/** Default confirmation lifetime. */
export const CONFIRMATION_TTL_MS = 5 * 60 * 1000

/** Drop expired confirmations; called opportunistically. */
function pruneConfirmations() {
  const now = Date.now()
  for (const [token, entry] of pendingConfirmations) {
    if (entry.expiresAt <= now) pendingConfirmations.delete(token)
  }
}

/**
 * Strip protocol fields before hashing the intent.
 * @param {Record<string, unknown>} args
 * @returns {Record<string, unknown>}
 */
function intentArgs(args) {
  const { confirmation_token: _token, dry_run: _dryRun, ...rest } = args ?? {}
  return rest
}

/** @param {string} toolName @param {Record<string, unknown>} args @returns {string} */
export function intentHash(toolName, args) {
  return sha256(`${toolName}\u0000${stableStringify(intentArgs(args))}`)
}

/**
 * Build a `NEEDS_APPROVAL` result for a DIS/DES tool: performs no mutation and
 * returns a single-use token bound to the tool name and arguments.
 * @param {string} toolName
 * @param {Record<string, unknown>} args
 * @param {{
 *   action: string, target?: string, impact?: string, rollback?: string,
 *   backup?: { available: boolean, newest?: string, age_hours?: number, suggestion?: string },
 *   facts?: unknown,
 * }} plan
 * @returns {object} tool result envelope
 */
export function needsApproval(toolName, args, plan) {
  pruneConfirmations()
  const token = randomToken()
  const expiresAt = Date.now() + CONFIRMATION_TTL_MS
  pendingConfirmations.set(token, {
    toolName,
    argsHash: intentHash(toolName, args),
    expiresAt,
    plan: {
      action: plan.action,
      ...(plan.target === undefined ? {} : { target: plan.target }),
      ...(plan.impact === undefined ? {} : { impact: plan.impact }),
      ...(plan.rollback === undefined ? {} : { rollback: plan.rollback }),
      ...(plan.backup === undefined ? {} : { backup: plan.backup }),
      ...(plan.facts === undefined ? {} : { facts: plan.facts }),
    },
  })
  return {
    ok: false,
    error: {
      code: 'NEEDS_APPROVAL',
      message: `This action needs explicit user confirmation: ${plan.action}.`,
      hint: 'Explain the impact to the user in plain language, wait for an explicit "yes", then call the same tool with the same arguments and confirmation_token.',
      retryable: false,
    },
    data: {
      ...plan,
      token,
      expires_at: new Date(expiresAt).toISOString(),
      confirm_with: 'Repeat the identical call with confirmation_token set to this token. Any argument change invalidates it.',
    },
    meta: { source: [], fetched_at: new Date().toISOString(), redacted: false, truncated: false },
  }
}

/**
 * Verify and consume a confirmation token. Throws {@link ToolError} when the
 * call does not match the approved intent or the token expired.
 * @param {string} toolName
 * @param {Record<string, unknown>} args
 * @returns {void}
 */
export function consumeApproval(toolName, args) {
  const token = args?.confirmation_token
  if (typeof token !== 'string' || token === '') {
    throw new ToolError('NEEDS_APPROVAL', 'confirmation_token is required to execute this action.', {
      hint: 'First call the tool without the token to receive a confirmation request, then confirm with the user.',
    })
  }
  pruneConfirmations()
  const entry = pendingConfirmations.get(token)
  if (entry === undefined) {
    throw new ToolError('CONFLICT', 'The confirmation token is unknown, already used, or expired.', {
      hint: 'Call the tool again without a token to prepare a fresh confirmation request, then ask the user again.',
    })
  }
  pendingConfirmations.delete(token)
  if (entry.toolName !== toolName) {
    throw new ToolError('CONFLICT', 'The confirmation token was issued for a different action.', {
      hint: 'Ask the user again for the action you actually want to perform.',
    })
  }
  if (entry.argsHash !== intentHash(toolName, args)) {
    throw new ToolError('CONFLICT', 'The action arguments changed after the user approved it.', {
      hint: 'Call the tool again without a token and re-confirm the exact arguments with the user.',
    })
  }
  if (entry.expiresAt <= Date.now()) {
    throw new ToolError('CONFLICT', 'The confirmation token expired.', {
      hint: 'Prepare a fresh confirmation request and ask the user again.',
    })
  }
}

/** @returns {number} number of outstanding confirmation requests (tests/diagnostics) */
export function pendingConfirmationCount() {
  pruneConfirmations()
  return pendingConfirmations.size
}

/** Clear all outstanding confirmations (tests). */
export function resetConfirmations() {
  pendingConfirmations.clear()
}
