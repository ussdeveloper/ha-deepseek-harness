/**
 * DeepSeek Harness plugin entry: registers every Home Assistant tool.
 *
 * Loaded from the image through `plugin/cordis.patch.yml` by absolute path, so
 * it must stay dependency-free: plain ESM and relative imports only (bare
 * package imports would not resolve from an immutable image path — verified in
 * `scratch/plugin-smoke/ha-tools/`).
 *
 * Tool modules each export an array of raw tool definitions (`{ name,
 * description, parameters, output, xClass, execute }`). This entry composes
 * them, applies the capability filter from `lib/safety.js` (`read_only` mode),
 * strips the plugin-only `xClass` field and registers the rest with the host's
 * `tools` service. Registration is effect-based: disposing the plugin fiber
 * unregisters everything.
 *
 * @module plugin
 */

import { filterTools, readOnly } from '../lib/safety.js'
import * as haModule from './tools/ha.js'
import * as supModule from './tools/sup.js'
import * as configModule from './tools/config.js'
import * as memoryModule from './tools/memory.js'
import * as monitorModule from './tools/monitor.js'
import * as knowledgeModule from './tools/knowledge.js'
import * as builderModule from './tools/builder.js'
import * as notifyModule from './tools/notify.js'
import * as extrasModule from './tools/extras.js'

/** Stable Cordis plugin name. */
export const name = 'ha-deepseek-harness'

/** Services this plugin contributes to / needs. */
export const inject = ['tools']

/** The tool modules, in registration order. */
export const toolModules = Object.freeze({
  ha: haModule,
  sup: supModule,
  config: configModule,
  memory: memoryModule,
  monitor: monitorModule,
  knowledge: knowledgeModule,
  builder: builderModule,
  notify: notifyModule,
  extras: extrasModule,
})

/**
 * Accept both export shapes used by the tool modules: `export default tools`
 * and `export const tools = [...]`.
 * @param {Record<string, unknown>} module namespace object
 * @returns {object[]}
 */
function moduleTools(module) {
  const candidate = module?.default ?? module?.tools
  return Array.isArray(candidate) ? candidate : []
}

/**
 * Flatten the tool definitions of all given modules.
 * @param {Record<string, Record<string, unknown>>} [modules]
 * @returns {object[]}
 */
export function collectDefinitions(modules = toolModules) {
  const definitions = []
  const seen = new Set()
  for (const [moduleName, module] of Object.entries(modules)) {
    for (const definition of moduleTools(module)) {
      if (definition === null || typeof definition !== 'object' || typeof definition.name !== 'string') {
        continue
      }
      if (seen.has(definition.name)) {
        console.warn(`[ha-deepseek-harness] duplicate tool name "${definition.name}" in ${moduleName}; keeping the first`)
        continue
      }
      seen.add(definition.name)
      definitions.push(definition)
    }
  }
  return definitions
}

/**
 * Mount the plugin: filter by capability mode and register every tool.
 * @param {{ tools: { register(definition: object): void } }} ctx Cordis plugin context
 * @returns {number} number of registered tools
 */
export function apply(ctx) {
  const readOnlyMode = readOnly()
  const definitions = filterTools(collectDefinitions())
  let registered = 0
  for (const definition of definitions) {
    const { xClass, ...registration } = definition
    void xClass
    ctx.tools.register(registration)
    registered += 1
  }
  console.log(`[ha-deepseek-harness] registered ${registered} tools (read_only=${readOnlyMode})`)
  return registered
}
