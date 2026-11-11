/**
 * Local app builder tools: scaffold, lint and build/install.
 *
 * Tool definitions only — `plugin/index.js` registers them after applying the
 * read-only filter and stripping `xClass`.
 *
 * @module plugin/tools/builder
 */

import { fail, ok, toErrorResult, renderJson } from '../../lib/result.js'
import { canManageAddons, classify, consumeApproval, needsApproval } from '../../lib/safety.js'
import { build, scaffold, validate } from '../../lib/addon-builder.js'

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

export const tools = [
  tool(
    'addon_scaffold',
    'Scaffold a complete local Home Assistant app under /addons/<slug>: config.yaml (options + schema), Dockerfile, run.sh (LF, executable), README.md, DOCS.md, CHANGELOG.md, translations/en.yaml and optional extra files. Templates: bash, python, node; interfaces: ingress, port, none. Refuses to overwrite an existing folder unless overwrite=true. No secrets are written; secrets belong in password-type options.',
    {
      name: { type: 'string', description: 'Human app name, e.g. "My Sensor Bridge".' },
      description: { type: 'string', description: 'One-sentence purpose shown in the app store.' },
      slug: { type: 'string', description: 'Folder/URL slug [a-z0-9_-]{1,64}; derived from the name when omitted.' },
      version: { type: 'string', description: 'Quoted semver, default "0.1.0".' },
      type: { type: 'string', enum: ['bash', 'python', 'node'], description: 'Entry point language (default bash).' },
      interface: { type: 'string', enum: ['ingress', 'port', 'none'], description: 'Exposure: ingress panel, a host port, or no network interface.' },
      port: { type: 'integer', minimum: 1, maximum: 65535, description: 'Host port for interface=port (and container port).' },
      ingress_port: { type: 'integer', minimum: 1, maximum: 65535, description: 'Container port the app listens on for ingress (default 8099).' },
      options: { type: 'object', additionalProperties: true, description: 'Default option values, e.g. {"url":"","log_level":"info"}.' },
      schema: { type: 'object', additionalProperties: { type: 'string' }, description: 'Option schema tokens, e.g. {"log_level":"list(debug|info)","api_key":"password"}.' },
      arch: { type: 'array', items: { type: 'string' }, description: 'Architectures (default aarch64, amd64).' },
      map: { type: 'object', additionalProperties: true, description: 'Map types, e.g. {"homeassistant_config":"rw"}.' },
      rootfs: { type: 'object', additionalProperties: { type: 'string' }, description: 'Extra files, path → content, written under rootfs/.' },
      hassio_api: { type: 'boolean', description: 'Request Supervisor API access (needs hassio_role manager).' },
      homeassistant_api: { type: 'boolean', description: 'Request Home Assistant Core API access.' },
      panel_title: { type: 'string', description: 'Sidebar title for ingress apps.' },
      panel_icon: { type: 'string', description: 'Sidebar icon, e.g. mdi:puzzle.' },
      startup: { type: 'string', enum: ['initialize', 'system', 'services', 'application', 'once'], description: 'Startup stage.' },
      boot: { type: 'string', enum: ['auto', 'manual', 'manual_only'], description: 'Boot behaviour.' },
      overwrite: { type: 'boolean', description: 'Replace an existing folder (default false).' },
    },
    ['name'],
    async (args) => {
      const result = await scaffold(args)
      return ok(
        `Scaffolded local app "${result.slug}" (${result.files.length} files) at /addons/${result.slug}${result.overwritten ? ' (overwritten)' : ''}. Next: addon_validate.`,
        result,
      )
    },
  ),
  tool(
    'addon_validate',
    'Lint a local app folder without touching the Supervisor: required config keys, quoted version, slug/folder match, architectures, init, ports, ingress, options/schema parity, map types, privileges, unknown keys, run.sh line endings and missing files. Errors must be fixed before building; privilege warnings need explicit user consent.',
    {
      slug: { type: 'string', description: 'App folder slug under /addons.' },
    },
    ['slug'],
    async (args) => {
      const result = await validate(args.slug)
      const summary = result.available
        ? `Local app "${result.slug}" is valid${result.warnings.length > 0 ? ` with ${result.warnings.length} warning(s)` : ''}.`
        : `Local app "${result.slug}" has ${result.errors.length} error(s); fix them before building.`
      return ok(summary, result)
    },
  ),
  tool(
    'addon_build',
    'Reload the Supervisor store, install or rebuild the local app and wait for the job outcome. Requires the allow_addon_management option and an explicit user confirmation (single-use confirmation token). On failure it returns the app log and Supervisor log tails plus fix hints. It does not start, stop or restart other apps.',
    {
      slug: { type: 'string', description: 'App folder slug under /addons.' },
      mode: { type: 'string', enum: ['install', 'rebuild'], description: 'install for a new app, rebuild to iterate on an installed one (default install).' },
      force: { type: 'boolean', description: 'For rebuild: force the rebuild even when the version did not change.' },
      wait: { type: 'boolean', description: 'Wait for the Supervisor job (default true).' },
      timeout_ms: { type: 'integer', minimum: 5_000, maximum: 1_800_000, description: 'Job wait timeout (default 300000).' },
      confirmation_token: { type: 'string', description: 'Single-use token from the previous NEEDS_APPROVAL response.' },
    },
    ['slug'],
    async (args) => {
      if (!canManageAddons()) {
        return fail('FORBIDDEN', 'Add-on management is disabled in the add-on options.', {
          hint: 'Enable the "allow_addon_management" option in the DeepSeek Harness app configuration, then retry.',
        })
      }
      const validation = await validate(args.slug)
      if (!validation.available) {
        return fail('INVALID_ARGUMENT', `Local app "${args.slug}" does not pass validation.`, {
          hint: 'Call addon_validate, fix every error, then build again.',
          data: { errors: validation.errors.slice(0, 20), warnings: validation.warnings.slice(0, 10) },
        })
      }
      if (typeof args.confirmation_token !== 'string' || args.confirmation_token === '') {
        return needsApproval('addon_build', args, {
          action: `Build and install the local app "${validation.slug}"`,
          target: `${validation.path}`,
          impact: 'The Supervisor builds a Docker image from /addons/' + validation.slug + ' and installs it. The build can take several minutes and creates or replaces the installed app.',
          rollback: 'Uninstall the app from Settings → Apps (or ask me to rebuild an older version); the scaffolded files stay in /addons.',
          facts: {
            slug: validation.slug,
            version: validation.version ?? null,
            files: validation.files.length,
            warnings: validation.warnings.slice(0, 10),
            mode: args.mode ?? 'install',
          },
        })
      }
      consumeApproval('addon_build', args)
      const result = await build({
        slug: args.slug,
        mode: args.mode,
        force: args.force,
        wait: args.wait,
        timeout_ms: args.timeout_ms,
      })
      if (!result.ok) {
        return fail('UPSTREAM_ERROR', result.error ?? 'The local app build failed.', {
          hint: 'Read `logs.addon` and `logs.supervisor`; common causes are CRLF in run.sh, a bad Dockerfile or an invalid config.yaml.',
          data: result,
        })
      }
      return ok(
        `Local app "${result.slug}" ${result.mode === 'install' ? 'installed' : 'rebuilt'}${result.job_id === null ? '' : ` (job ${result.job_id}${result.done ? ', done' : ''})`}. Start it from Settings → Apps if it is not running.`,
        result,
      )
    },
  ),
]

export default tools
