// P5 (plan §5.1-5): the Models-directory alias runtime is RETIRED. The
// historical wrapper route is never registered by the zero-Provider build, so
// no directory entry is published, replaced, or synchronized anymore. What
// remains is the READ-ONLY historical source reader: completed messages that
// name the retired wrapper route must stay readable, exportable, compactable
// and replayable, so historical session surfaces still resolve the identity
// the route always had (route name, display label, and the official DeepSeek
// settings address it aliased). Nothing here writes Host state.

const DEFAULT_WRAPPER_ROUTE = 'deepseek-vision'
const DEFAULT_TEXT_PROVIDER = 'deepseek-official'
const HISTORICAL_WRAPPER_DISPLAY_NAME = 'DeepSeek + 自动识图'

function nonEmptyString(value, fallback) {
  return typeof value === 'string' && value !== '' ? value : fallback
}

function resolvedVisionRouterConfig(ctx, baseConfig) {
  try {
    const settings = ctx && typeof ctx.get === 'function' ? ctx.get('settings') : undefined
    const live = settings && typeof settings.get === 'function' ? settings.get('vision-router') : undefined
    if (live && typeof live === 'object') return live
  } catch {
    // The settings service is optional during early composition startup.
  }
  return baseConfig && typeof baseConfig === 'object' ? baseConfig : {}
}

/**
 * READ-ONLY historical source reader (plan §5.1-5). Resolves the historical
 * wrapper-directory identity for labeling/history surfaces: the configured
 * wrapper route name, the label the row always carried, and the official
 * DeepSeek settings address it aliased. The wrapper adapter is never live in
 * the zero-Provider build, so — unlike the retired runtime — the reader does
 * NOT require live topology. A stale/advanced `textProvider` must never
 * relabel the row: the historical wrapper always aliased official DeepSeek.
 * Returns undefined when the Host lacks the read-only directory API or the
 * official settings address cannot be resolved (fail-closed: never invent an
 * address, never publish anything).
 * @param {object} ctx - Host context (llm/settings read access only).
 * @param {object} [baseConfig] - composition fallback for the settings read.
 * @returns {object|undefined} the historical directory entry, for reads only.
 */
export function resolveWrapperDirectoryEntry(ctx, baseConfig = {}) {
  const llm = ctx && ctx.llm
  if (
    !llm ||
    typeof llm.listConfigurableProviders !== 'function'
  ) {
    return undefined
  }

  const config = resolvedVisionRouterConfig(ctx, baseConfig)
  const wrapperRoute = nonEmptyString(config.wrapperRoute, DEFAULT_WRAPPER_ROUTE)

  let configurableProviders
  try {
    configurableProviders = llm.listConfigurableProviders()
  } catch {
    return undefined
  }
  if (!Array.isArray(configurableProviders)) return undefined

  const source = configurableProviders.find(
    (entry) => entry && entry.provider === DEFAULT_TEXT_PROVIDER,
  )
  if (!source || typeof source.settingsNs !== 'string' || source.settingsNs === '') return undefined

  return {
    provider: wrapperRoute,
    displayName: HISTORICAL_WRAPPER_DISPLAY_NAME,
    settingsNs: source.settingsNs,
    settingsPath: Array.isArray(source.settingsPath) ? [...source.settingsPath] : [],
  }
}

/**
 * P5 retirement (plan §5.1-5): runtime directory ownership is retired. The
 * historical composition call site keeps its signature, but the installer
 * publishes nothing, subscribes to nothing, and owns nothing — on every Host
 * shape, including runtimes without any directory API. The returned disposer
 * is a no-op so the caller's lifecycle wiring stays valid.
 * @returns {() => undefined} inert disposer.
 */
export function installWrapperDirectoryAlias() {
  return () => undefined
}
