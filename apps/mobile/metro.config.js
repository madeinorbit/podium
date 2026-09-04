const path = require('node:path')
const { getDefaultConfig } = require('expo/metro-config')
const { redirectGestureHandler } = require('./scripts/metro-gesture-handler-web')

const projectRoot = __dirname
const workspaceRoot = path.resolve(projectRoot, '../..')

/** @type {import('expo/metro-config').MetroConfig} */
const config = getDefaultConfig(projectRoot)

// THE PACKAGES ARE NOT UNDER THIS CHECKOUT (POD-3171). Bun's isolated linker with
// `globalStore` (bunfig.toml) leaves node_modules a farm of symlinks whose targets
// live in a store shared by every worktree — `~/.bun/install/cache/links` by
// default. Metro resolves a symlink to its real path and then refuses anything
// outside a watched root, so the store has to be one: without it a bare
// `react/jsx-runtime` from inside a dependency is reported as "could not be found"
// while Node resolves it fine.
const bunLinkStore = (() => {
  const cache = process.env.BUN_INSTALL_CACHE_DIR
    ? path.resolve(process.env.BUN_INSTALL_CACHE_DIR)
    : path.join(
        process.env.BUN_INSTALL || path.join(require('node:os').homedir(), '.bun'),
        'install',
        'cache',
      )
  return path.join(cache, 'links')
})()

config.watchFolders = Array.from(
  new Set([
    ...(config.watchFolders || []),
    workspaceRoot,
    ...(require('node:fs').existsSync(bunLinkStore) ? [bunLinkStore] : []),
  ]),
)
// expo-sqlite's web worker imports its SQLite engine as a `.wasm` asset. Metro
// otherwise treats that exact, present file as unresolvable, which makes the
// browser lane's mandatory mobile-web prerequisite fail before Playwright can
// start its harness server.
config.resolver.assetExts = Array.from(new Set([...(config.resolver.assetExts || []), 'wasm']))
config.resolver.unstable_conditionsByPlatform = {
  ...config.resolver.unstable_conditionsByPlatform,
  web: ['@podium/source', ...(config.resolver.unstable_conditionsByPlatform?.web || [])],
  ios: ['@podium/source', ...(config.resolver.unstable_conditionsByPlatform?.ios || [])],
  android: ['@podium/source', ...(config.resolver.unstable_conditionsByPlatform?.android || [])],
}

// Point the web build at a gesture handler that actually handles gestures; the
// rule and the reasons live in ./scripts/metro-gesture-handler-web.js [POD-402].
const baseResolveRequest = config.resolver.resolveRequest
config.resolver.resolveRequest = (context, moduleName, platform) => {
  const resolved = (baseResolveRequest ?? context.resolveRequest)(context, moduleName, platform)
  if (resolved?.type !== 'sourceFile') return resolved
  const real = redirectGestureHandler(resolved.filePath, platform)
  return real ? { type: 'sourceFile', filePath: real } : resolved
}

module.exports = config
