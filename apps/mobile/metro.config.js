const path = require('node:path')
const { getDefaultConfig } = require('expo/metro-config')
const { redirectGestureHandler } = require('./scripts/metro-gesture-handler-web')

const projectRoot = __dirname
const workspaceRoot = path.resolve(projectRoot, '../..')

/** @type {import('expo/metro-config').MetroConfig} */
const config = getDefaultConfig(projectRoot)

config.watchFolders = Array.from(new Set([...(config.watchFolders || []), workspaceRoot]))
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
