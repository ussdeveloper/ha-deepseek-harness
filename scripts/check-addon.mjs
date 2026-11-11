#!/usr/bin/env node
/**
 * Dependency-free repository validator.
 *
 * Checks the add-on manifest and repository layout, that every referenced file
 * exists, that the plugin bundle composes, and that the skill playbooks only
 * reference tools the plugin actually registers.
 *
 * Usage: node scripts/check-addon.mjs
 */

import { readFile, readdir, stat } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
const ADDON = join(ROOT, 'deepseek_harness')
const errors = []
const warnings = []

/** @param {string} message */
function error(message) {
  errors.push(message)
}

/** @param {string} message */
function warn(message) {
  warnings.push(message)
}

/** Read a YAML-ish file and return its top-level scalar/array keys (no YAML dependency). */
function topLevelKeys(text) {
  const keys = new Map()
  for (const line of text.split(/\r?\n/)) {
    const match = /^([A-Za-z0-9_-]+):\s*(.*)$/.exec(line)
    if (match !== null) keys.set(match[1], match[2].trim())
  }
  return keys
}

/** Existence check with a helpful error. */
async function requireFile(relative) {
  const path = join(ROOT, relative)
  if (!existsSync(path)) {
    error(`missing required file: ${relative}`)
    return false
  }
  return true
}

const configPath = join(ADDON, 'config.yaml')
if (!existsSync(configPath)) {
  error('missing deepseek_harness/config.yaml')
} else {
  const config = topLevelKeys(await readFile(configPath, 'utf8'))
  for (const required of ['name', 'version', 'slug', 'description', 'arch', 'startup', 'boot', 'map', 'options', 'schema', 'ingress', 'ingress_port']) {
    if (!config.has(required)) error(`config.yaml: missing required key "${required}"`)
  }
  if ((config.get('slug') ?? '').replace(/"/g, '') !== 'deepseek_harness') error('config.yaml: slug must stay "deepseek_harness" (backup/update identity)')
  if (config.get('ingress') !== 'true') error('config.yaml: ingress must be true')
  if (config.get('ingress_port') !== '8099') error('config.yaml: ingress_port must be 8099 (watchdog/shim contract)')
  if (config.get('hassio_role') !== 'manager') error('config.yaml: hassio_role should be "manager" (least privilege for our tools)')
  if (config.has('docker_api') && config.get('docker_api') !== 'false') error('config.yaml: docker_api must stay disabled')
  if (config.has('host_network') && config.get('host_network') !== 'false') error('config.yaml: host_network must stay disabled')
  if (config.has('privileged') && config.get('privileged') !== 'false') error('config.yaml: privileged must stay disabled')
  if (!/^"?0\.\d+\.\d+"?$/.test(config.get('version') ?? '')) warn('config.yaml: version should look like 0.1.0')
}

for (const file of [
  'repository.yaml',
  'README.md',
  'LICENSE',
  'deepseek_harness/Dockerfile',
  'deepseek_harness/DOCS.md',
  'deepseek_harness/CHANGELOG.md',
  'deepseek_harness/icon.png',
  'deepseek_harness/logo.png',
  'deepseek_harness/translations/en.yaml',
  'deepseek_harness/rootfs/opt/ha-dsh/profile.patch.yml',
  'deepseek_harness/rootfs/opt/ha-dsh/plugin/package.json',
  'deepseek_harness/rootfs/opt/ha-dsh/plugin/cordis.patch.yml',
  'deepseek_harness/rootfs/opt/ha-dsh/runtime/entrypoint.mjs',
  'deepseek_harness/rootfs/opt/ha-dsh/runtime/ingress-shim.mjs',
  'deepseek_harness/rootfs/opt/ha-dsh/runtime/collector.mjs',
  'deepseek_harness/rootfs/opt/ha-dsh/prompts/AGENTS.md',
]) {
  await requireFile(file)
}

const repository = await readFile(join(ROOT, 'repository.yaml'), 'utf8')
for (const key of ['name', 'url']) {
  if (!new RegExp(`^${key}:`, 'm').test(repository)) error(`repository.yaml: missing "${key}"`)
}

// The runtime entrypoint and the managed DSH profile must agree on the
// workspace path (it is where the agent writes files and what the sandbox
// treats as the workspace root).
try {
  const entrypoint = await readFile(join(ADDON, 'rootfs/opt/ha-dsh/runtime/entrypoint.mjs'), 'utf8')
  const profilePatch = await readFile(join(ADDON, 'rootfs/opt/ha-dsh/profile.patch.yml'), 'utf8')
  const runtimeWorkspace = /const WORKSPACE = '([^']+)'/.exec(entrypoint)?.[1]
  const sandboxWorkspace = /workspaceRoot:\s*(\S+)/.exec(profilePatch)?.[1]
  if (runtimeWorkspace === undefined || sandboxWorkspace === undefined) {
    error('workspace: cannot determine the workspace path from entrypoint/profile patch')
  } else if (runtimeWorkspace !== sandboxWorkspace) {
    error(`workspace: entrypoint uses ${runtimeWorkspace} but sandbox-policy uses ${sandboxWorkspace}`)
  } else if (runtimeWorkspace !== '/config/deepseek-harness') {
    warn(`workspace: agent workspace is ${runtimeWorkspace} (expected /config/deepseek-harness)`)
  } else {
    console.log(`workspace: ${runtimeWorkspace}`)
  }
} catch (workspaceError) {
  error(`workspace: ${workspaceError instanceof Error ? workspaceError.message : workspaceError}`)
}

// The plugin must compose without touching the network or a Home Assistant host.
let toolNames = new Set()
try {
  const plugin = await import(pathToFileURL(join(ADDON, 'rootfs/opt/ha-dsh/plugin/index.js')).href)
  const definitions = plugin.collectDefinitions()
  toolNames = new Set(definitions.map((definition) => definition.name))
  if (definitions.length < 60) error(`plugin: expected at least 60 tools, composed ${definitions.length}`)
  const unsafe = definitions.filter((definition) => !['R', 'SW', 'ACT', 'DIS', 'DES'].includes(definition.xClass))
  if (unsafe.length > 0) error(`plugin: tool(s) without a valid xClass: ${unsafe.map((d) => d.name).join(', ')}`)
  for (const forbidden of ['ha_set_state', 'ha_fire_event', 'ha_wipe_datadisk']) {
    if (toolNames.has(forbidden)) error(`plugin: forbidden tool registered: ${forbidden}`)
  }
  console.log(`plugin: composed ${definitions.length} tools (${[...definitions].filter((d) => d.xClass === 'R').length} read-only)`)
} catch (composeError) {
  error(`plugin: failed to compose: ${composeError instanceof Error ? composeError.message : composeError}`)
}

// Skills: valid frontmatter and only implemented tool names.
const skillsRoot = join(ADDON, 'rootfs/opt/ha-dsh/skills')
if (!existsSync(skillsRoot)) {
  error('missing skills directory')
} else {
  const entries = await readdir(skillsRoot, { withFileTypes: true })
  let count = 0
  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    const file = join(skillsRoot, entry.name, 'SKILL.md')
    if (!existsSync(file)) {
      error(`skill ${entry.name}: missing SKILL.md`)
      continue
    }
    count += 1
    const body = await readFile(file, 'utf8')
    if (!/^---\r?\n[\s\S]*?name:\s*\S+[\s\S]*?description:\s*\S+[\s\S]*?\r?\n---/.test(body)) {
      error(`skill ${entry.name}: missing YAML frontmatter with name and description`)
    }
    for (const match of body.matchAll(/`((?:ha|sup|config|memory|monitor|addon|knowledge|notify)_[a-z_]+)`/g)) {
      const name = match[1]
      if (!toolNames.has(name)) error(`skill ${entry.name}: references unknown tool "${name}"`)
    }
  }
  if (count < 4) error(`skills: expected 4 skill bundles, found ${count}`)
  console.log(`skills: ${count} bundles validated`)
}

// Icons: PNG signature + expected size for icon.png.
try {
  const icon = await readFile(join(ADDON, 'icon.png'))
  if (!(icon[0] === 0x89 && icon.subarray(1, 4).toString() === 'PNG')) error('icon.png: not a PNG file')
  const width = icon.readUInt32BE(16)
  const height = icon.readUInt32BE(20)
  if (width !== 128 || height !== 128) warn(`icon.png: expected 128x128, got ${width}x${height}`)
} catch {
  error('icon.png: unreadable')
}

// Runtime files must be syntactically valid and free of common mistakes.
for (const file of [
  'deepseek_harness/rootfs/opt/ha-dsh/runtime/entrypoint.mjs',
  'deepseek_harness/rootfs/opt/ha-dsh/runtime/ingress-shim.mjs',
  'deepseek_harness/rootfs/opt/ha-dsh/runtime/collector.mjs',
]) {
  const text = await readFile(join(ROOT, file), 'utf8')
  if (/\bSUPERVISOR_TOKEN\s*=\s*['"]/.test(text)) error(`${file}: looks like a hardcoded Supervisor token`)
}

if (warnings.length > 0) {
  console.log('\nWarnings:')
  for (const warning of warnings) console.log(`  - ${warning}`)
}

if (errors.length > 0) {
  console.error('\nErrors:')
  for (const message of errors) console.error(`  - ${message}`)
  process.exit(1)
}

console.log('\nAdd-on repository is valid.')


