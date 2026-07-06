const path = require('path')
const { getDefaultConfig } = require('expo/metro-config')

const projectRoot = __dirname
const workspaceRoot = path.resolve(projectRoot, '../..')

/** @type {import('expo/metro-config').MetroConfig} */
const config = getDefaultConfig(projectRoot)

config.watchFolders = Array.from(new Set([...(config.watchFolders || []), workspaceRoot]))
config.resolver.unstable_conditionsByPlatform = {
  ...config.resolver.unstable_conditionsByPlatform,
  web: ['@podium/source', ...(config.resolver.unstable_conditionsByPlatform?.web || [])],
  ios: ['@podium/source', ...(config.resolver.unstable_conditionsByPlatform?.ios || [])],
  android: ['@podium/source', ...(config.resolver.unstable_conditionsByPlatform?.android || [])],
}

module.exports = config
