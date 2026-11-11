/**
 * Local Home Assistant app (add-on) builder.
 *
 * `scaffold` writes a complete local app directory under `/addons/<slug>`:
 * `config.yaml`, `Dockerfile`, `run.sh` (LF + executable), `README.md`,
 * `DOCS.md`, `CHANGELOG.md`, `translations/en.yaml` and optional extra files
 * (`rootfs/` entries). `validate` enforces the lint rules from
 * `docs/research/ha-domain.md` §8.3. `build` drives the Supervisor:
 * `POST /store/reload` → install (or rebuild) job → poll `/jobs/<id>` → on
 * failure collect the app log and the Supervisor log tail.
 *
 * Nothing here calls a model and nothing writes outside `/addons`.
 *
 * @module addon-builder
 */

import { chmod, mkdir, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'

import { getPaths } from './paths.js'
import { ToolError, isPlainObject, nowIso } from './result.js'
import { sup } from './supervisor.js'

/** Valid slug shape. */
export const SLUG_PATTERN = /^[a-z0-9_-]{1,64}$/

/** Slugs that collide with Supervisor directories or reserved names. */
export const RESERVED_SLUGS = Object.freeze([
  'config', 'rootfs', 'deps', 'ssl', 'share', 'media', 'backup', 'data', 'addons', 'addon',
  'local', 'store', 'supervisor', 'core', 'hassio', 'homeassistant', 'docker', 'build',
  'snapshot', 'snapshots', 'internal', 'self', 'repository', 'repositories',
])

/** Scaffold languages. */
export const TEMPLATE_TYPES = Object.freeze(['bash', 'python', 'node'])

/** Network interfaces an app can expose. */
export const INTERFACE_TYPES = Object.freeze(['ingress', 'port', 'none'])

/** Architectures accepted without a warning. */
const ARCH_OK = new Set(['aarch64', 'amd64'])

/** Architectures accepted with a deprecation warning. */
const ARCH_DEPRECATED = new Set(['armhf', 'armv7', 'i386'])

/** `map` types accepted by the Supervisor. */
const MAP_TYPES = new Set(['homeassistant_config', 'app_config', 'local_apps', 'share', 'ssl', 'media', 'backup', 'data', 'all_app_configs'])

/** Startup/boot enums. */
const STARTUP_VALUES = new Set(['initialize', 'system', 'services', 'application', 'once'])
const BOOT_VALUES = new Set(['auto', 'manual', 'manual_only'])

/** Privilege keys that lower the app security rating. */
const PRIVILEGE_KEYS = Object.freeze(['privileged', 'full_access', 'host_network', 'host_pid', 'docker_api'])

/** Config keys the Supervisor understands; unknown keys are typos. */
const ALLOWED_CONFIG_KEYS = new Set([
  'name', 'version', 'slug', 'description', 'arch', 'image', 'init', 'startup', 'boot',
  'hostname', 'options', 'schema', 'ports', 'ports_description', 'ingress', 'ingress_port',
  'ingress_entry', 'panel_icon', 'panel_title', 'panel_admin', 'hassio_api', 'hassio_role',
  'homeassistant_api', 'docker_api', 'host_network', 'host_pid', 'privileged', 'full_access',
  'apparmor', 'map', 'watchdog', 'healthcheck', 'environment', 'url', 'stage', 'backup',
  'backup_exclude', 'advanced', 'audio', 'video', 'uart', 'usb', 'gpio', 'kernel_modules',
  'devicetree', 'devices', 'machine', 'auth_api', 'services', 'discovery', 'homeassistant',
  'breaking_versions', 'changelog', 'documentation', 'logo', 'icon', 'legacy', 'timezone',
  'host_uts', 'udev', 'tmpfs', 'journald',
])

/** Simple schema type tokens accepted by the Supervisor. */
const SCHEMA_TYPES = new Set(['str', 'int', 'float', 'bool', 'password', 'email', 'url', 'port', 'device', 'time', 'date', 'uuid', 'match', 'list', 'mqtt'])

/** Default options injected by the scaffold. */
const DEFAULT_OPTIONS = Object.freeze({ log_level: 'info' })
const DEFAULT_SCHEMA = Object.freeze({ log_level: 'list(debug|info|warning|error)' })

/** Dockerfile templates (HA base image brings bashio and S6). */
const DOCKERFILES = Object.freeze({
  bash: [
    'FROM ghcr.io/home-assistant/base:3.24',
    '',
    'COPY run.sh /',
    'RUN chmod a+x /run.sh',
    '',
    'CMD [ "/run.sh" ]',
    '',
  ].join('\n'),
  python: [
    'FROM ghcr.io/home-assistant/base:3.24',
    '',
    'RUN apk add --no-cache python3',
    '',
    'COPY run.sh /',
    'COPY app /app',
    'RUN chmod a+x /run.sh',
    '',
    'CMD [ "/run.sh" ]',
    '',
  ].join('\n'),
  node: [
    'FROM ghcr.io/home-assistant/base:3.24',
    '',
    'RUN apk add --no-cache nodejs',
    '',
    'COPY run.sh /',
    'COPY app /app',
    'RUN chmod a+x /run.sh',
    '',
    'CMD [ "/run.sh" ]',
    '',
  ].join('\n'),
})

/** @param {string} slug @returns {string} absolute app directory */
export function addonPath(slug) {
  return join(getPaths().addonsDir, slug)
}

/** @param {unknown} name @returns {string} */
export function slugify(name) {
  const slug = String(name ?? '')
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64)
  return slug === '' ? 'local-app' : slug
}

/**
 * Validate and normalise a slug.
 * @param {unknown} slug
 * @returns {string}
 */
export function validateSlug(slug) {
  if (typeof slug !== 'string' || slug === '') throw new ToolError('INVALID_ARGUMENT', 'A slug is required.')
  const value = slug.trim()
  if (!SLUG_PATTERN.test(value)) {
    throw new ToolError('INVALID_ARGUMENT', `Invalid app slug "${value}": use [a-z0-9_-]{1,64}.`, {
      hint: 'Lowercase letters, digits, hyphen and underscore only.',
    })
  }
  if (RESERVED_SLUGS.includes(value)) {
    throw new ToolError('INVALID_ARGUMENT', `The slug "${value}" is reserved by Home Assistant.`, {
      hint: 'Pick a distinct slug, e.g. "my-local-app".',
    })
  }
  return value
}

// ---------------------------------------------------------------------------
// YAML emission
// ---------------------------------------------------------------------------

const YAML_BARE = /^[A-Za-z0-9][A-Za-z0-9 .,/+:_-]*$/
const YAML_RESERVED = /^(true|false|yes|no|on|off|null|~)$/i
const YAML_NUMBER = /^-?\d+(\.\d+)?$/

/** @param {unknown} value @returns {string} */
function yamlScalar(value) {
  if (value === null || value === undefined) return 'null'
  if (typeof value === 'boolean') return value ? 'true' : 'false'
  if (typeof value === 'number') return Number.isFinite(value) ? String(value) : 'null'
  if (Array.isArray(value)) return `[${value.map(yamlScalar).join(', ')}]`
  if (isPlainObject(value)) {
    return `{${Object.entries(value).map(([key, item]) => `${yamlScalar(key)}: ${yamlScalar(item)}`).join(', ')}}`
  }
  const text = String(value)
  if (text !== '' && YAML_BARE.test(text) && !YAML_RESERVED.test(text) && !YAML_NUMBER.test(text)) return text
  return JSON.stringify(text)
}

/** @param {string} key @returns {string} */
function yamlKey(key) {
  return /^[A-Za-z0-9_][A-Za-z0-9_./-]*$/.test(key) ? key : JSON.stringify(key)
}

/** @param {object} object @param {number} indent @returns {string[]} */
function emitMap(object, indent) {
  const pad = ' '.repeat(indent)
  const lines = []
  for (const [key, value] of Object.entries(object)) {
    if (isPlainObject(value)) {
      lines.push(`${pad}${yamlKey(key)}:`)
      lines.push(...emitMap(value, indent + 2))
    } else if (Array.isArray(value)) {
      if (value.length === 0) {
        lines.push(`${pad}${yamlKey(key)}: []`)
        continue
      }
      lines.push(`${pad}${yamlKey(key)}:`)
      for (const item of value) lines.push(`${pad}  - ${yamlScalar(item)}`)
    } else {
      lines.push(`${pad}${yamlKey(key)}: ${yamlScalar(value)}`)
    }
  }
  return lines
}

/** @param {object} spec @returns {string} */
function generateConfigYaml(spec) {
  const lines = [
    '# Local Home Assistant app generated by DeepSeek Harness.',
    `name: ${yamlScalar(spec.name)}`,
    `version: ${JSON.stringify(spec.version)}`,
    `slug: ${yamlScalar(spec.slug)}`,
    `description: ${yamlScalar(spec.description)}`,
    'arch:',
    ...spec.arch.map((arch) => `  - ${arch}`),
    'init: false',
    `startup: ${spec.startup}`,
    `boot: ${spec.boot}`,
  ]
  if (spec.interface === 'ingress') {
    lines.push('ingress: true')
    lines.push(`ingress_port: ${spec.ingress_port}`)
    lines.push(`panel_title: ${yamlScalar(spec.panel_title ?? spec.name)}`)
    lines.push(`panel_icon: ${yamlScalar(spec.panel_icon ?? 'mdi:puzzle')}`)
    lines.push('panel_admin: false')
  } else if (spec.interface === 'port') {
    lines.push('ports:')
    lines.push(`  ${spec.port}/tcp: ${spec.port}`)
    lines.push('ports_description:')
    lines.push(`  ${spec.port}/tcp: Web interface`)
  }
  if (spec.hassio_api === true) lines.push('hassio_api: true')
  if (spec.homeassistant_api === true) lines.push('homeassistant_api: true')
  if (isPlainObject(spec.map) && Object.keys(spec.map).length > 0) {
    lines.push('map:')
    for (const [type, access] of Object.entries(spec.map)) lines.push(`  ${type}: ${access}`)
  }
  lines.push('options:')
  lines.push(...emitMap(spec.options, 2))
  lines.push('schema:')
  lines.push(...emitMap(spec.schema, 2))
  return `${lines.join('\n')}\n`
}

/** @param {object} spec @returns {string} */
function generateRunSh(spec) {
  const lines = [
    '#!/command/with-contenv bashio',
    '# shellcheck shell=bash',
    'set -e',
    '',
    `bashio::log.info "Starting ${spec.name.replace(/["\\$`]/g, '')}"`,
  ]
  if (spec.interface === 'ingress' || spec.interface === 'port') {
    lines.push(`export DSH_APP_PORT="${spec.interface === 'ingress' ? spec.ingress_port : spec.port}"`)
  }
  if (spec.type === 'node') lines.push('exec node /app/index.js')
  else if (spec.type === 'python') lines.push('exec python3 /app/main.py')
  else lines.push('# TODO: start your program here, then keep the script in the foreground.')
  return `${lines.join('\n')}\n`
}

/** @param {object} spec @returns {string} */
function generateNodeMain(spec) {
  return [
    "'use strict'",
    '',
    "const { createServer } = require('node:http')",
    '',
    "const port = Number(process.env.DSH_APP_PORT || 8099)",
    "const name = '" + spec.slug.replace(/'/g, '') + "'",
    '',
    'createServer((request, response) => {',
    "  response.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' })",
    '  response.end(`${name} is running\\n`)',
    '}).listen(port, "0.0.0.0", () => {',
    '  console.log(`${name} listening on ${port}`)',
    '})',
    '',
  ].join('\n')
}

/** @param {object} spec @returns {string} */
function generatePythonMain(spec) {
  return [
    'import os',
    'from http.server import BaseHTTPRequestHandler, HTTPServer',
    '',
    `PORT = int(os.environ.get("DSH_APP_PORT", "${spec.interface === 'none' ? '8099' : String(spec.interface === 'ingress' ? spec.ingress_port : spec.port)}"))`,
    '',
    '',
    'class Handler(BaseHTTPRequestHandler):',
    '    def do_GET(self):',
    '        body = b"' + spec.name.replace(/["\\]/g, '') + ' is running\\n"',
    '        self.send_response(200)',
    '        self.send_header("content-type", "text/plain; charset=utf-8")',
    '        self.send_header("content-length", str(len(body)))',
    '        self.end_headers()',
    '        self.wfile.write(body)',
    '',
    '',
    'if __name__ == "__main__":',
    '    HTTPServer(("0.0.0.0", PORT), Handler).serve_forever()',
    '',
  ].join('\n')
}

/** @param {object} spec @returns {string} */
function generateReadme(spec) {
  return [
    `# ${spec.name}`,
    '',
    spec.description,
    '',
    `Local Home Assistant app scaffolded by DeepSeek Harness (\`/${'addons'}/${spec.slug}\`).`,
    '',
    '## Install',
    '',
    'Settings → Apps → App store → Check for updates → Local apps → ' + `"${spec.name}"` + ' → Install → Start.',
    '',
    '## Develop',
    '',
    '1. Edit the files in this folder.',
    '2. Bump `version` in `config.yaml` for normal updates (or rebuild with force while developing).',
    '3. Reload the app store and rebuild from the app page.',
    '',
    '## Files',
    '',
    '- `config.yaml` — app metadata, options and schema.',
    '- `Dockerfile` — image build recipe (Home Assistant base image).',
    '- `run.sh` — entrypoint (must keep LF line endings).',
    '- `translations/en.yaml` — option labels.',
    '- `DOCS.md` — the documentation tab.',
    '- `CHANGELOG.md` — the changelog tab.',
    '',
  ].join('\n')
}

/** @param {object} spec @returns {string} */
function generateDocs(spec) {
  const optionLines = Object.keys(spec.options).map((key) => `- \`${key}\` — ${yamlScalar(spec.options[key])}`)
  return [
    `# ${spec.name}`,
    '',
    spec.description,
    '',
    '## Configuration',
    '',
    optionLines.length === 0 ? 'This app has no options.' : optionLines.join('\n'),
    '',
    '## Notes',
    '',
    '- Data written to `/data` survives restarts and updates.',
    '- This is a local app: it is built on your Home Assistant machine.',
    '',
  ].join('\n')
}

/** @param {object} spec @returns {string} */
function generateChangelog(spec) {
  return ['# Changelog', '', `## ${spec.version}`, '', '- Initial scaffold generated by DeepSeek Harness.', ''].join('\n')
}

/** @param {object} spec @returns {string} */
function generateTranslations(spec) {
  const lines = ['configuration:']
  for (const key of Object.keys(spec.options)) {
    const label = key.replace(/_/g, ' ').replace(/^\w/, (char) => char.toUpperCase())
    lines.push(`  ${yamlKey(key)}:`)
    lines.push(`    name: ${yamlScalar(label)}`)
    lines.push(`    description: ${yamlScalar('See DOCS.md for details about this option.')}`)
  }
  return `${lines.join('\n')}\n`
}

/**
 * Create a local app scaffold.
 * @param {object} spec
 * @returns {Promise<object>}
 */
export async function scaffold(spec = {}) {
  if (!isPlainObject(spec)) throw new ToolError('INVALID_ARGUMENT', 'A scaffold spec object is required.')
  const name = typeof spec.name === 'string' ? spec.name.trim() : ''
  if (name === '') throw new ToolError('INVALID_ARGUMENT', 'The app needs a human `name`.')
  if (name.length > 64) throw new ToolError('INVALID_ARGUMENT', 'The app name is limited to 64 characters.')
  const slug = validateSlug(typeof spec.slug === 'string' && spec.slug !== '' ? spec.slug : slugify(name))
  const type = typeof spec.type === 'string' && spec.type !== '' ? spec.type : 'bash'
  if (!TEMPLATE_TYPES.includes(type)) {
    throw new ToolError('INVALID_ARGUMENT', `Unknown app type "${type}".`, { hint: `Use one of: ${TEMPLATE_TYPES.join(', ')}.` })
  }
  let interfaceType = typeof spec.interface === 'string' && spec.interface !== ''
    ? spec.interface
    : spec.port !== undefined
      ? 'port'
      : type === 'bash'
        ? 'none'
        : 'ingress'
  if (!INTERFACE_TYPES.includes(interfaceType)) {
    throw new ToolError('INVALID_ARGUMENT', `Unknown interface "${interfaceType}".`, { hint: `Use one of: ${INTERFACE_TYPES.join(', ')}.` })
  }
  const version = typeof spec.version === 'string' && spec.version !== '' ? spec.version : '0.1.0'
  if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version)) {
    throw new ToolError('INVALID_ARGUMENT', `Invalid version "${version}": use a quoted semver such as "0.1.0".`)
  }
  const arch = Array.isArray(spec.arch) && spec.arch.length > 0 ? spec.arch.map(String) : ['aarch64', 'amd64']
  const knownArch = new Set([...ARCH_OK, ...ARCH_DEPRECATED])
  for (const value of arch) {
    if (!knownArch.has(value)) throw new ToolError('INVALID_ARGUMENT', `Unknown architecture "${value}".`, { hint: `Known: ${[...knownArch].join(', ')}.` })
  }
  const port = Number.isInteger(spec.port) ? spec.port : 8099
  const ingressPort = Number.isInteger(spec.ingress_port) ? spec.ingress_port : 8099
  if ((interfaceType === 'port' && (port < 1 || port > 65535)) || (interfaceType === 'ingress' && (ingressPort < 1 || ingressPort > 65535))) {
    throw new ToolError('INVALID_ARGUMENT', 'Ports must be between 1 and 65535.')
  }
  const description = typeof spec.description === 'string' && spec.description.trim() !== ''
    ? spec.description.trim().slice(0, 200)
    : `${name} — local app built with DeepSeek Harness.`
  const map = normalizeMapSpec(spec.map)
  const optionsProvided = isPlainObject(spec.options) && Object.keys(spec.options).length > 0
  const options = optionsProvided ? spec.options : { ...DEFAULT_OPTIONS }
  const schema = isPlainObject(spec.schema) && Object.keys(spec.schema).length > 0
    ? spec.schema
    : optionsProvided ? deriveSchema(options) : { ...DEFAULT_SCHEMA }
  const overwrite = spec.overwrite === true
  const dir = addonPath(slug)

  let existing = []
  try {
    existing = await readdir(dir)
  } catch {
    existing = []
  }
  if (existing.length > 0 && !overwrite) {
    throw new ToolError('CONFLICT', `The app folder /addons/${slug} already exists.`, {
      hint: 'Pass overwrite=true to replace the scaffold, or choose another slug.',
      data: { slug, path: dir, files: existing.slice(0, 50) },
    })
  }
  if (overwrite && existing.length > 0) await rm(dir, { recursive: true, force: true })
  await mkdir(dir, { recursive: true })

  const template = { name, slug, version, description, type, interface: interfaceType, port, ingress_port: ingressPort, arch, options, schema, map, startup: spec.startup ?? 'application', boot: spec.boot ?? 'auto', panel_title: spec.panel_title, panel_icon: spec.panel_icon, hassio_api: spec.hassio_api === true, homeassistant_api: spec.homeassistant_api === true }

  /** @type {Record<string, string>} */
  const files = {
    'config.yaml': generateConfigYaml({ ...template, startup: STARTUP_VALUES.has(String(template.startup)) ? template.startup : 'application', boot: BOOT_VALUES.has(String(template.boot)) ? template.boot : 'auto' }),
    Dockerfile: DOCKERFILES[type],
    'run.sh': generateRunSh(template),
    'README.md': generateReadme(template),
    'DOCS.md': generateDocs(template),
    'CHANGELOG.md': generateChangelog(template),
    'translations/en.yaml': generateTranslations(template),
  }
  if (type === 'node') files['app/index.js'] = generateNodeMain(template)
  if (type === 'python') files['app/main.py'] = generatePythonMain(template)

  if (isPlainObject(spec.rootfs)) {
    for (const [relative, content] of Object.entries(spec.rootfs)) {
      const safe = String(relative).replaceAll('\\', '/').replace(/^\/+/, '')
      if (safe === '' || safe.split('/').some((segment) => segment === '..' || segment === '.')) {
        throw new ToolError('INVALID_ARGUMENT', `rootfs path is not safe: ${relative}`)
      }
      if (typeof content !== 'string') throw new ToolError('INVALID_ARGUMENT', `rootfs entry ${safe} must be a string.`)
      files[`rootfs/${safe}`] = safe.endsWith('.sh') ? content.replace(/\r\n/g, '\n') : content
    }
  }

  const written = []
  for (const [relative, content] of Object.entries(files)) {
    const target = join(dir, relative)
    await mkdir(dirname(target), { recursive: true })
    await writeFile(target, content, { encoding: 'utf8', mode: relative.endsWith('.sh') ? 0o755 : 0o644 })
    if (relative.endsWith('.sh')) {
      try {
        await chmod(target, 0o755)
      } catch {
        // Windows hosts do not support POSIX modes; the Dockerfile also chmods.
      }
    }
    written.push(relative)
  }
  written.sort()
  return {
    slug,
    path: dir,
    files: written,
    overwritten: existing.length > 0,
    type,
    interface: interfaceType,
    version,
    created_at: nowIso(),
  }
}

/** @param {unknown} options @returns {object} */
function deriveSchema(options) {
  const schema = {}
  for (const [key, value] of Object.entries(options)) {
    if (typeof value === 'boolean') schema[key] = 'bool'
    else if (typeof value === 'number') schema[key] = Number.isInteger(value) ? 'int' : 'float'
    else schema[key] = 'str'
  }
  return schema
}

/** @param {unknown} raw @returns {object} */
function normalizeMapSpec(raw) {
  if (raw === undefined || raw === null) return {}
  const map = {}
  if (Array.isArray(raw)) {
    for (const entry of raw) {
      if (typeof entry !== 'string') continue
      const [type, access = 'rw'] = entry.split(':')
      if (MAP_TYPES.has(type)) map[type] = access === 'ro' ? 'ro' : 'rw'
    }
    return map
  }
  if (isPlainObject(raw)) {
    for (const [type, value] of Object.entries(raw)) {
      if (!MAP_TYPES.has(type)) continue
      map[type] = value === 'ro' || value === false ? 'ro' : 'rw'
    }
  }
  return map
}

// ---------------------------------------------------------------------------
// Minimal YAML parser (enough for config.yaml)
// ---------------------------------------------------------------------------

/** @param {string} line @returns {string} */
function stripYamlComment(line) {
  let quote = null
  for (let index = 0; index < line.length; index++) {
    const char = line[index]
    if (quote !== null) {
      if (char === '\\' && quote === '"') index += 1
      else if (char === quote) quote = null
      continue
    }
    if (char === '"' || char === "'") {
      quote = char
      continue
    }
    if (char === '#' && (index === 0 || /\s/.test(line[index - 1]))) return line.slice(0, index).trimEnd()
  }
  return line
}

/** @param {unknown} text @returns {unknown} */
function parseYamlScalar(text) {
  const value = String(text ?? '').trim()
  if (value === '') return ''
  if (value.startsWith('"') && value.endsWith('"') && value.length >= 2) {
    try {
      return JSON.parse(value)
    } catch {
      return value.slice(1, -1)
    }
  }
  if (value.startsWith("'") && value.endsWith("'") && value.length >= 2) return value.slice(1, -1).replace(/''/g, "'")
  if (value.startsWith('[') && value.endsWith(']')) {
    return value.slice(1, -1).split(',').map((part) => parseYamlScalar(part)).filter((part) => part !== '')
  }
  if (value.startsWith('{') && value.endsWith('}')) {
    const object = {}
    for (const part of value.slice(1, -1).split(',')) {
      const separator = part.indexOf(':')
      if (separator === -1) continue
      object[part.slice(0, separator).trim()] = parseYamlScalar(part.slice(separator + 1))
    }
    return object
  }
  if (/^(true|yes|on)$/i.test(value)) return true
  if (/^(false|no|off)$/i.test(value)) return false
  if (/^(null|~)$/i.test(value)) return null
  if (/^-?\d+$/.test(value)) return Number(value)
  if (/^-?\d+\.\d+$/.test(value)) return Number(value)
  return value
}

/**
 * Parse the small YAML subset produced by `scaffold` (plus simple hand edits).
 * Returns `{ value, errors }`; unsupported syntax is reported, never thrown.
 * @param {string} text
 * @returns {{ value: object, errors: Array<{line: number, message: string}> }}
 */
export function parseYaml(text) {
  /** @type {Array<{line: number, message: string}>} */
  const errors = []
  const root = {}
  /** @type {Array<{indent: number, value: object|unknown[]}>} */
  const stack = [{ indent: -1, value: root }]
  const lines = String(text ?? '').split(/\r?\n/)
  for (let index = 0; index < lines.length; index++) {
    const rawLine = lines[index]
    const line = index + 1
    if (rawLine.trim() === '' || /^\s*#/.test(rawLine)) continue
    if (rawLine.includes('\t')) {
      errors.push({ line, message: 'tabs are not allowed in YAML (use 2 spaces)' })
      continue
    }
    const indent = rawLine.length - rawLine.trimStart().length
    const content = stripYamlComment(rawLine.trim())
    if (content === '') continue
    while (stack.length > 1 && stack[stack.length - 1].indent >= indent) stack.pop()
    const parent = stack[stack.length - 1]
    if (content.startsWith('- ') || content === '-') {
      if (!Array.isArray(parent.value)) {
        errors.push({ line, message: 'list item where a mapping was expected' })
        continue
      }
      const rest = content === '-' ? '' : content.slice(2).trim()
      if (rest === '') {
        errors.push({ line, message: 'nested list items are not supported' })
        continue
      }
      const mappingItem = rest.match(/^([^:]+):\s+(\S.*)$/)
      if (mappingItem !== null) {
        parent.value.push({ [mappingItem[1].trim()]: parseYamlScalar(mappingItem[2]) })
      } else {
        parent.value.push(parseYamlScalar(rest))
      }
      continue
    }
    const mapping = content.match(/^([^:]+?):(?:\s+(.*))?$/)
    if (mapping === null) {
      errors.push({ line, message: `unsupported YAML syntax: ${content.slice(0, 60)}` })
      continue
    }
    if (Array.isArray(parent.value)) {
      errors.push({ line, message: 'mapping key inside a list' })
      continue
    }
    const key = mapping[1].trim()
    const valueText = mapping[2] === undefined ? '' : mapping[2].trim()
    if (valueText === '') {
      const next = nextContent(lines, index + 1)
      const child = next !== null && (next.startsWith('- ') || next === '-') ? [] : {}
      parent.value[key] = child
      stack.push({ indent, value: child })
    } else {
      parent.value[key] = parseYamlScalar(valueText)
    }
  }
  return { value: root, errors }
}

/** @param {string[]} lines @param {number} start @returns {string|null} */
function nextContent(lines, start) {
  for (let index = start; index < lines.length; index++) {
    const raw = lines[index]
    if (raw.trim() === '' || /^\s*#/.test(raw)) continue
    return stripYamlComment(raw.trim())
  }
  return null
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

/**
 * Lint a local app folder.
 * @param {string} slug
 * @returns {Promise<object>}
 */
export async function validate(slug) {
  const normalised = validateSlug(slug)
  const dir = addonPath(normalised)
  /** @type {Array<{code: string, message: string, path?: string}>} */
  const errors = []
  /** @type {Array<{code: string, message: string, path?: string}>} */
  const warnings = []
  let entries = []
  try {
    entries = await readdir(dir)
  } catch {
    return {
      slug: normalised,
      path: dir,
      available: false,
      errors: [{ code: 'NOT_FOUND', message: `No app folder at ${dir}.`, path: dir }],
      warnings,
      files: [],
    }
  }
  const files = await listFiles(dir, 2)
  const configName = ['config.yaml', 'config.yml', 'config.json'].find((name) => entries.includes(name))
  /** @type {Record<string, unknown>} */
  let config = {}
  let rawConfig = ''
  if (configName === undefined) {
    errors.push({ code: 'CONFIG_MISSING', message: 'config.yaml is required (config.yaml, config.yml or config.json).' })
  } else {
    rawConfig = await readFile(join(dir, configName), 'utf8')
    if (rawConfig.includes('\r\n')) errors.push({ code: 'CONFIG_CRLF', message: `${configName} must use LF line endings.` })
    if (configName.endsWith('.json')) {
      try {
        const parsed = JSON.parse(rawConfig)
        config = isPlainObject(parsed) ? parsed : {}
        if (!isPlainObject(parsed)) errors.push({ code: 'CONFIG_PARSE', message: `${configName} must contain a JSON object.` })
      } catch (error) {
        errors.push({ code: 'CONFIG_PARSE', message: `${configName} is not valid JSON: ${error instanceof Error ? error.message : String(error)}` })
      }
    } else {
      if (rawConfig.includes('\t')) errors.push({ code: 'CONFIG_TAB', message: 'YAML must use spaces, not tabs.' })
      const parsed = parseYaml(rawConfig)
      for (const parseError of parsed.errors) {
        errors.push({ code: 'CONFIG_PARSE', message: `line ${parseError.line}: ${parseError.message}` })
      }
      config = parsed.value
    }
  }

  const parseFailed = errors.some((error) => error.code === 'CONFIG_PARSE' || error.code === 'CONFIG_TAB' || error.code === 'CONFIG_CRLF')
  if (configName !== undefined && !parseFailed) {
    const required = ['name', 'version', 'slug', 'description', 'arch']
    for (const key of required) {
      if (config[key] === undefined) errors.push({ code: 'MISSING_KEY', message: `Missing required config key "${key}".` })
    }
    if (configName.endsWith('.yaml') || configName.endsWith('.yml')) {
      const versionLine = rawConfig.match(/^version[ \t]*:[ \t]*(.*)$/m)
      if (versionLine !== null) {
        const value = versionLine[1].trim()
        if (!/^".*"$/.test(value) && !/^'.*'$/.test(value)) {
          errors.push({ code: 'VERSION_UNQUOTED', message: 'version must be a quoted string: "1.10" would otherwise be parsed as 1.1.' })
        }
      }
    }
    if (typeof config.version === 'string') {
      if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(config.version)) {
        warnings.push({ code: 'VERSION_FORMAT', message: `version "${config.version}" is not semver-like.` })
      }
    } else if (config.version !== undefined) {
      errors.push({ code: 'VERSION_NOT_STRING', message: 'version must be a quoted string.' })
    }
    const slugValue = typeof config.slug === 'string' ? config.slug : ''
    if (slugValue === '') errors.push({ code: 'BAD_SLUG', message: 'slug must be a non-empty string.' })
    else if (!SLUG_PATTERN.test(slugValue)) {
      errors.push({ code: 'BAD_SLUG', message: `slug "${slugValue}" must match [a-z0-9_-]{1,64}.` })
    } else if (slugValue !== normalised) {
      warnings.push({ code: 'FOLDER_MISMATCH', message: `slug "${slugValue}" does not match the folder name "${normalised}".` })
    }
    if (config.name !== undefined && (typeof config.name !== 'string' || config.name.trim() === '')) {
      errors.push({ code: 'BAD_NAME', message: 'name must be a non-empty string.' })
    }
    if (config.description !== undefined && typeof config.description !== 'string') {
      errors.push({ code: 'BAD_DESCRIPTION', message: 'description must be a string.' })
    }
    // Architectures
    if (config.arch !== undefined) {
      if (!Array.isArray(config.arch)) {
        errors.push({ code: 'BAD_ARCH', message: 'arch must be a list, e.g. [aarch64, amd64].' })
      } else {
        for (const value of config.arch) {
          if (ARCH_OK.has(String(value))) continue
          if (ARCH_DEPRECATED.has(String(value))) warnings.push({ code: 'DEPRECATED_ARCH', message: `arch "${value}" is deprecated.` })
          else errors.push({ code: 'BAD_ARCH', message: `Unknown architecture "${value}".` })
        }
      }
    }
    if (config.init === undefined) warnings.push({ code: 'INIT_MISSING', message: 'Set init: false for Home Assistant base images (S6 is the init).' })
    else if (config.init !== false) warnings.push({ code: 'INIT_TRUE', message: 'init must be false for Home Assistant base images.' })
    if (config.image !== undefined) warnings.push({ code: 'IMAGE_LOCAL', message: 'image is ignored for local apps; remove it so local changes are used.' })
    if (config.startup !== undefined && !STARTUP_VALUES.has(String(config.startup))) {
      errors.push({ code: 'BAD_STARTUP', message: `startup must be one of ${[...STARTUP_VALUES].join(', ')}.` })
    }
    if (config.boot !== undefined && !BOOT_VALUES.has(String(config.boot))) {
      errors.push({ code: 'BAD_BOOT', message: `boot must be one of ${[...BOOT_VALUES].join(', ')}.` })
    }
    if (config.hassio_role !== undefined && !['default', 'manager', 'admin'].includes(String(config.hassio_role))) {
      errors.push({ code: 'BAD_HASSIO_ROLE', message: 'hassio_role must be default, manager or admin.' })
    }
    // Ports
    if (config.ports !== undefined) {
      if (!isPlainObject(config.ports)) {
        errors.push({ code: 'BAD_PORTS', message: 'ports must be a map like "8099/tcp": 8099.' })
      } else {
        for (const [key, value] of Object.entries(config.ports)) {
          const match = key.match(/^(\d{1,5})\/(tcp|udp)$/)
          if (match === null) {
            errors.push({ code: 'BAD_PORT_KEY', message: `port "${key}" must look like "8099/tcp".` })
            continue
          }
          const containerPort = Number(match[1])
          if (containerPort < 1 || containerPort > 65535) errors.push({ code: 'BAD_PORT', message: `container port ${containerPort} is out of range.` })
          if (value !== null && (!Number.isInteger(value) || value < 1 || value > 65535)) {
            errors.push({ code: 'BAD_PORT', message: `host port for "${key}" must be an integer 1-65535 or null.` })
          }
          const ingressPort = config.ingress_port === undefined ? null : Number(config.ingress_port)
          if (config.ingress === true && ingressPort === 0 && containerPort >= 62000 && containerPort <= 65500) {
            errors.push({ code: 'INGRESS_PORT_CONFLICT', message: `Port ${containerPort} is in the ingress range and cannot be exposed when ingress_port is 0.` })
          }
        }
      }
    }
    if (config.ingress === true) {
      if (config.ingress_port !== undefined) {
        const ingressPort = Number(config.ingress_port)
        if (!Number.isInteger(ingressPort) || ingressPort < 0 || ingressPort > 65535) {
          errors.push({ code: 'BAD_INGRESS_PORT', message: 'ingress_port must be an integer 0-65535.' })
        }
      } else {
        warnings.push({ code: 'INGRESS_PORT_DEFAULT', message: 'ingress is enabled without ingress_port; the app must listen on 8099.' })
      }
    }
    // map
    if (config.map !== undefined) {
      const mapEntries = []
      if (Array.isArray(config.map)) {
        for (const entry of config.map) {
          if (typeof entry === 'string') mapEntries.push(...entry.split(',').map((part) => part.trim()))
          else if (isPlainObject(entry)) mapEntries.push(...Object.keys(entry))
          else errors.push({ code: 'BAD_MAP', message: 'map entries must be "type:access" strings.' })
        }
      } else if (isPlainObject(config.map)) {
        mapEntries.push(...Object.keys(config.map))
      } else {
        errors.push({ code: 'BAD_MAP', message: 'map must be a list of "type:access" strings or a map.' })
      }
      for (const entry of mapEntries) {
        const [type, access] = entry.split(':')
        if (!MAP_TYPES.has(type)) errors.push({ code: 'BAD_MAP_TYPE', message: `Unknown map type "${type}".` })
        if (access !== undefined && !['rw', 'ro'].includes(access)) errors.push({ code: 'BAD_MAP_ACCESS', message: `map access for "${type}" must be ro or rw.` })
      }
    }
    // Options / schema parity
    const options = isPlainObject(config.options) ? config.options : {}
    const schema = isPlainObject(config.schema) ? config.schema : {}
    if (config.options !== undefined && !isPlainObject(config.options)) errors.push({ code: 'BAD_OPTIONS', message: 'options must be a map.' })
    if (config.schema !== undefined && !isPlainObject(config.schema)) errors.push({ code: 'BAD_SCHEMA', message: 'schema must be a map.' })
    for (const [key, token] of Object.entries(schema)) {
      if (typeof token !== 'string') {
        errors.push({ code: 'BAD_SCHEMA_TYPE', message: `schema.${key} must be a type string.` })
        continue
      }
      const optional = token.endsWith('?')
      const base = optional ? token.slice(0, -1) : token
      const listMatch = base.match(/^list\((.+)\)$/)
      const isList = listMatch !== null
      if (!isList && !SCHEMA_TYPES.has(base)) {
        errors.push({ code: 'BAD_SCHEMA_TYPE', message: `schema.${key} has unknown type "${token}".` })
      }
      if (isList && listMatch[1].split('|').some((part) => part.trim() === '')) {
        errors.push({ code: 'BAD_SCHEMA_TYPE', message: `schema.${key} list() has an empty option.` })
      }
      if (!(key in options) && !optional) {
        warnings.push({ code: 'MISSING_DEFAULT', message: `schema.${key} has no default in options; the app may not start.` })
      }
    }
    for (const key of Object.keys(options)) {
      if (!(key in schema)) warnings.push({ code: 'UNDOCUMENTED_OPTION', message: `option "${key}" has no schema entry.` })
    }
    // Privileges
    for (const key of PRIVILEGE_KEYS) {
      if (config[key] === true) warnings.push({ code: 'PRIVILEGE', message: `${key}: true lowers the app security rating and needs explicit user consent.` })
    }
    if (config.apparmor === false) warnings.push({ code: 'PRIVILEGE', message: 'apparmor: false lowers the app security rating and needs explicit user consent.' })
    // Backup policy
    if (config.backup !== undefined) {
      if (typeof config.backup === 'string') {
        if (!['hot', 'cold'].includes(config.backup)) errors.push({ code: 'BAD_BACKUP', message: 'backup must be hot or cold.' })
        else if (config.backup === 'cold' && (config.backup_pre !== undefined || config.backup_post !== undefined)) {
          warnings.push({ code: 'BACKUP_IGNORED', message: 'cold backups ignore backup_pre/backup_post.' })
        }
      } else if (isPlainObject(config.backup)) {
        if (config.backup.mode !== undefined && !['hot', 'cold'].includes(String(config.backup.mode))) {
          errors.push({ code: 'BAD_BACKUP', message: 'backup.mode must be hot or cold.' })
        }
        if (config.backup.mode === 'cold' && (config.backup.pre !== undefined || config.backup.post !== undefined)) {
          warnings.push({ code: 'BACKUP_IGNORED', message: 'cold backups ignore backup.pre/backup.post.' })
        }
      } else {
        errors.push({ code: 'BAD_BACKUP', message: 'backup must be "hot", "cold" or an object.' })
      }
    }
    // Unknown keys
    for (const key of Object.keys(config)) {
      if (!ALLOWED_CONFIG_KEYS.has(key)) {
        errors.push({ code: 'UNKNOWN_KEY', message: `Unknown config key "${key}" (the Supervisor silently ignores typos).` })
      }
    }
  }

  // Files
  if (!entries.includes('Dockerfile')) errors.push({ code: 'DOCKERFILE_MISSING', message: 'Dockerfile is required to build a local app.' })
  const runSh = entries.includes('run.sh')
  if (!runSh) {
    errors.push({ code: 'RUN_SH_MISSING', message: 'run.sh is required.' })
  } else {
    const runText = await readFile(join(dir, 'run.sh'), 'utf8')
    if (runText.includes('\r\n')) errors.push({ code: 'RUN_SH_CRLF', message: 'run.sh must use LF line endings (CRLF fails with an unrelated-looking error).' })
    const firstLine = runText.split('\n')[0] ?? ''
    if (!firstLine.startsWith('#!')) warnings.push({ code: 'RUN_SH_SHEBANG', message: 'run.sh should start with #!/command/with-contenv bashio.' })
    else if (!firstLine.includes('bashio') && !firstLine.includes('/bin/bash') && !firstLine.includes('/bin/sh')) {
      warnings.push({ code: 'RUN_SH_SHEBANG', message: 'run.sh should use #!/command/with-contenv bashio to reach the Supervisor token.' })
    }
    try {
      const mode = (await stat(join(dir, 'run.sh'))).mode
      if (process.platform !== 'win32' && (mode & 0o111) === 0) warnings.push({ code: 'RUN_SH_NOT_EXECUTABLE', message: 'run.sh is not executable (chmod a+x).' })
    } catch {
      // ignore
    }
  }
  if (!entries.includes('README.md')) warnings.push({ code: 'README_MISSING', message: 'README.md is recommended for repository-facing docs.' })
  if (!entries.includes('DOCS.md')) warnings.push({ code: 'DOCS_MISSING', message: 'DOCS.md is recommended for the app documentation tab.' })
  if (!entries.includes('CHANGELOG.md')) warnings.push({ code: 'CHANGELOG_MISSING', message: 'CHANGELOG.md is recommended for the app changelog tab.' })
  if (!entries.includes('translations')) warnings.push({ code: 'TRANSLATIONS_MISSING', message: 'translations/en.yaml is recommended so option labels are readable.' })
  else if (!files.includes('translations/en.yaml')) warnings.push({ code: 'TRANSLATIONS_MISSING', message: 'translations/en.yaml is missing.' })

  return {
    slug: normalised,
    path: dir,
    config_path: configName === undefined ? null : join(dir, configName),
    name: typeof config.name === 'string' ? config.name : null,
    version: typeof config.version === 'string' ? config.version : null,
    available: errors.length === 0,
    errors,
    warnings,
    files,
  }
}

/** @param {string} dir @param {number} depth @param {string} [prefix] @returns {Promise<string[]>} */
async function listFiles(dir, depth, prefix = '') {
  /** @type {string[]} */
  const out = []
  let entries
  try {
    entries = await readdir(dir, { withFileTypes: true })
  } catch {
    return out
  }
  for (const entry of entries) {
    const relative = prefix === '' ? entry.name : `${prefix}/${entry.name}`
    if (entry.isDirectory()) {
      if (depth > 0) out.push(...(await listFiles(join(dir, entry.name), depth - 1, relative)))
    } else if (entry.isFile()) {
      out.push(relative)
    }
  }
  return out.sort()
}

// ---------------------------------------------------------------------------
// Build / install loop
// ---------------------------------------------------------------------------

/** Unwrap Supervisor `{result, data}` envelopes. */
function unwrap(payload) {
  if (isPlainObject(payload) && 'data' in payload && ('result' in payload || 'success' in payload)) return payload.data
  return payload
}

/** @param {unknown} payload @returns {string|null} */
function extractJobId(payload) {
  const data = unwrap(payload)
  if (isPlainObject(data)) {
    if (typeof data.job_id === 'string') return data.job_id
    if (isPlainObject(data.job) && typeof data.job.job_id === 'string') return data.job.job_id
  }
  if (isPlainObject(payload) && isPlainObject(payload.data)) {
    if (typeof payload.data.job_id === 'string') return payload.data.job_id
  }
  return null
}

/** @param {number} ms @returns {Promise<void>} */
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * Poll one Supervisor job with a hard timeout.
 * @param {string} jobId
 * @param {{ timeout_ms?: number, interval_ms?: number }} [options]
 * @returns {Promise<{done: boolean, progress: number, stage: string, errors: unknown[]}>}
 */
export async function pollJob(jobId, options = {}) {
  const timeoutMs = Number.isFinite(Number(options.timeout_ms)) ? Number(options.timeout_ms) : 300_000
  const intervalMs = Number.isFinite(Number(options.interval_ms)) ? Number(options.interval_ms) : 1_500
  const deadline = Date.now() + timeoutMs
  let last = null
  for (;;) {
    const response = await sup(`/jobs/${encodeURIComponent(jobId)}`, 'GET')
    if (!response.ok) {
      throw new ToolError('UPSTREAM_ERROR', `Supervisor job ${jobId} could not be read (HTTP ${response.status}).`, {
        hint: 'Check sup_job_status or the Supervisor log.',
        retryable: response.status >= 500,
      })
    }
    last = isPlainObject(unwrap(response.data)) ? unwrap(response.data) : {}
    if (last.done === true) {
      return {
        done: true,
        progress: Number(last.progress ?? 100),
        stage: String(last.stage ?? 'done'),
        errors: Array.isArray(last.errors) ? last.errors : [],
      }
    }
    if (Date.now() >= deadline) {
      throw new ToolError('UPSTREAM_ERROR', `Supervisor job ${jobId} did not finish within ${timeoutMs} ms.`, {
        hint: 'Read the job with sup_job_status, or check the Supervisor log.',
        retryable: true,
        data: { job_id: jobId, stage: last?.stage ?? null, progress: last?.progress ?? null },
      })
    }
    await sleep(intervalMs)
  }
}

/** @param {string} text @param {number} max @returns {string} */
function tail(text, max = 4000) {
  const value = String(text ?? '')
  if (value.length <= max) return value
  return `…[${value.length - max} chars omitted]\n${value.slice(-max)}`
}

/**
 * Collect the app log and the Supervisor log tail for a failed build.
 * @param {string} slug
 * @returns {Promise<{addon?: string, supervisor?: string}>}
 */
export async function collectLogs(slug) {
  /** @type {{addon?: string, supervisor?: string}} */
  const logs = {}
  // Local apps are exposed with the `local_` prefix once installed; try both.
  for (const candidate of [`/addons/local_${slug}/logs`, `/addons/${slug}/logs`]) {
    try {
      const response = await sup(candidate, 'GET')
      if (!response.ok) continue
      const text = typeof response.data === 'string' ? response.data : JSON.stringify(response.data)
      logs.addon = tail(text)
      break
    } catch (error) {
      logs.addon = `unavailable: ${error instanceof Error ? error.message : String(error)}`
    }
  }
  try {
    const response = await sup('/supervisor/logs', 'GET')
    const text = typeof response.data === 'string' ? response.data : JSON.stringify(response.data)
    logs.supervisor = tail(text)
  } catch (error) {
    logs.supervisor = `unavailable: ${error instanceof Error ? error.message : String(error)}`
  }
  return logs
}

/**
 * Reload the store, install or rebuild the local app and wait for the job.
 * @param {{
 *   slug: string, mode?: 'install'|'rebuild', force?: boolean, wait?: boolean,
 *   timeout_ms?: number, interval_ms?: number, reload?: boolean, logs?: boolean,
 * }} options
 * @returns {Promise<object>}
 */
export async function build(options = {}) {
  const started = Date.now()
  const slug = validateSlug(options.slug)
  const mode = options.mode === 'rebuild' ? 'rebuild' : 'install'
  const validation = await validate(slug)
  if (!validation.available) {
    throw new ToolError('INVALID_ARGUMENT', `Local app "${slug}" does not pass validation.`, {
      hint: 'Fix the errors, then build again.',
      data: { errors: validation.errors.slice(0, 20) },
    })
  }
  /** @type {object[]} */
  const steps = []
  if (options.reload !== false) {
    const response = await sup('/store/reload', 'POST')
    steps.push({ step: 'store_reload', ok: response.ok, status: response.status })
    if (!response.ok) {
      throw new ToolError('UPSTREAM_ERROR', `Supervisor /store/reload failed with HTTP ${response.status}.`, {
        hint: 'Read the Supervisor log: an invalid config.yaml usually prevents the local app from appearing.',
        data: { steps, logs: options.logs === false ? undefined : await collectLogs(slug) },
      })
    }
  }

  const send = mode === 'rebuild'
    ? () => rebuildRequest(slug, options.force !== false)
    : () => installRequest(slug)
  const response = await send()
  steps.push({ step: mode, ok: response.ok, status: response.status })
  if (!response.ok) {
    const logs = options.logs === false ? {} : await collectLogs(slug)
    return {
      ok: false,
      slug,
      mode,
      steps,
      job_id: null,
      done: false,
      error: `Supervisor ${mode} request failed with HTTP ${response.status}.`,
      logs,
      hints: buildHints(response.status),
      duration_ms: Date.now() - started,
    }
  }
  const jobId = extractJobId(response.data)
  let job = null
  if (options.wait !== false && jobId !== null) {
    try {
      job = await pollJob(jobId, { timeout_ms: options.timeout_ms, interval_ms: options.interval_ms })
    } catch (error) {
      const logs = options.logs === false ? {} : await collectLogs(slug)
      return {
        ok: false,
        slug,
        mode,
        steps,
        job_id: jobId,
        done: false,
        error: error instanceof Error ? error.message : String(error),
        logs,
        hints: ['A build that never finishes is usually a Docker build error; read the Supervisor log tail.'],
        duration_ms: Date.now() - started,
      }
    }
    steps.push({ step: 'job', ok: job.errors.length === 0, stage: job.stage, progress: job.progress })
    if (job.errors.length > 0) {
      const logs = options.logs === false ? {} : await collectLogs(slug)
      return {
        ok: false,
        slug,
        mode,
        steps,
        job_id: jobId,
        done: true,
        stage: job.stage,
        progress: job.progress,
        error: `The Supervisor job reported ${job.errors.length} error(s).`,
        job_errors: job.errors.slice(0, 20),
        logs,
        hints: buildHints(500),
        duration_ms: Date.now() - started,
      }
    }
  }
  return {
    ok: true,
    slug,
    mode,
    steps,
    job_id: jobId,
    done: job !== null,
    stage: job?.stage ?? null,
    progress: job?.progress ?? null,
    logs: {},
    duration_ms: Date.now() - started,
  }
}

/** @param {string} slug @returns {Promise<object>} */
async function installRequest(slug) {
  const primary = await sup(`/store/addons/local_${slug}/install`, 'POST', { background: true })
  if (primary.ok) return primary
  if (primary.status === 404 || primary.status === 400 || primary.status === 405) {
    return sup(`/addons/local_${slug}/install`, 'POST', { background: true })
  }
  return primary
}

/** @param {string} slug @param {boolean} force @returns {Promise<object>} */
async function rebuildRequest(slug, force) {
  const primary = await sup(`/addons/local_${slug}/rebuild`, 'POST', { force })
  if (primary.ok) return primary
  if (primary.status === 404 || primary.status === 405) {
    return sup(`/addons/${slug}/rebuild`, 'POST', { force })
  }
  return primary
}

/** @param {number} status @returns {string[]} */
function buildHints(status) {
  if (status === 404) return ['The app is not visible to the Supervisor: reload the store and check config.yaml in the Supervisor log.']
  if (status === 409) return ['A job may already be running; check the Supervisor and retry when it finishes.']
  return ['Check the Supervisor log for the Docker build output and fix the Dockerfile or dependencies.']
}
