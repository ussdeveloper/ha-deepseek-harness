/**
 * Resolved filesystem paths and add-on options for the Home Assistant plugin.
 *
 * Environment is read on every call so tests (and a restarted add-on) can
 * change options without re-importing modules. Keep this dependency-free:
 * only `node:path` is used.
 *
 * @module paths
 */

import { join } from 'node:path'

/** @param {string|undefined} value @param {boolean} fallback */
function parseBool(value, fallback) {
  if (value === undefined || value === '') return fallback
  return /^(1|true|yes|on)$/i.test(value)
}

/** @param {string|undefined} value @param {number} fallback */
function parseInt(value, fallback) {
  if (value === undefined || value === '') return fallback
  const parsed = Number.parseInt(value, 10)
  return Number.isFinite(parsed) ? parsed : fallback
}

/**
 * Filesystem locations used by the plugin, the collector and the ingress shim.
 * @returns {{
 *   data: string, memory: string, monitor: string, knowledge: string,
 *   configBackups: string, configDir: string, addonsDir: string,
 *   workspace: string, dshHome: string, supervisorUrl: string,
 * }}
 */
export function getPaths() {
  const data = process.env.DSH_DATA_DIR ?? '/data'
  return {
    data,
    memory: join(data, 'memory'),
    monitor: join(data, 'monitor'),
    knowledge: join(data, 'knowledge'),
    configBackups: join(data, 'config-backups'),
    // DSH's persistent home: profiles, session store, settings and managed
    // instruction files. It stays in /data, which add-on backups cover.
    dshHome: process.env.DSH_HOME ?? join(data, 'dsh-home'),
    configDir: process.env.DSH_HA_CONFIG_DIR ?? '/config',
    addonsDir: process.env.DSH_HA_ADDONS_DIR ?? '/addons',
    // The agent's workspace lives inside the Home Assistant config folder so
    // the user can see its files and HA backups include them.
    workspace: process.env.DSH_WORKSPACE ?? '/config/deepseek-harness',
    supervisorUrl: (process.env.DSH_SUPERVISOR_URL ?? 'http://supervisor').replace(/\/+$/, ''),
  }
}

/**
 * Add-on options rendered by the run script into environment variables.
 * @returns {{
 *   readOnly: boolean, allowRestarts: boolean, allowAddonManagement: boolean,
 *   monitorEnabled: boolean, notifyService: string, quietHours: string,
 *   backupRetention: number, publicUrl: string, webPort: number,
 *   ingressPort: number, monitorIntervalMin: number, digestTime: string,
 *   firstRunAnalysis: boolean, fullAccess: boolean,
 * }}
 */
export function getOptions() {
  return {
    readOnly: parseBool(process.env.DSH_OPT_READ_ONLY, false),
    fullAccess: parseBool(process.env.DSH_OPT_FULL_ACCESS, true),
    allowRestarts: parseBool(process.env.DSH_OPT_ALLOW_RESTARTS, false),
    allowAddonManagement: parseBool(process.env.DSH_OPT_ALLOW_ADDON_MANAGEMENT, false),
    allowHostManagement: parseBool(process.env.DSH_OPT_ALLOW_HOST_MANAGEMENT, true),
    monitorEnabled: parseBool(process.env.DSH_OPT_MONITOR_ENABLED, true),
    firstRunAnalysis: parseBool(process.env.DSH_OPT_FIRST_RUN_ANALYSIS, true),
    notifyService: process.env.DSH_OPT_NOTIFY_SERVICE ?? '',
    quietHours: process.env.DSH_OPT_QUIET_HOURS ?? '',
    backupRetention: parseInt(process.env.DSH_OPT_BACKUP_RETENTION, 7),
    publicUrl: process.env.DSH_OPT_PUBLIC_URL ?? '',
    webPort: parseInt(process.env.DSH_WEB_PORT, 3080),
    ingressPort: parseInt(process.env.DSH_INGRESS_PORT, 8099),
    monitorIntervalMin: parseInt(process.env.DSH_MONITOR_INTERVAL_MIN, 15),
    digestTime: process.env.DSH_DIGEST_TIME ?? '08:00',
  }
}

/** Add-on version reported by tools; injected at image build. */
export const VERSION = process.env.DSH_ADDON_VERSION ?? '0.1.0'
