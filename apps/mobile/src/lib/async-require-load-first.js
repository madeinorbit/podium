/**
 * METRO'S `asyncRequireModulePath` FOR THIS APP (POD-5370): Expo's own, except
 * that on web a split chunk named in an import's paths is loaded BEFORE its
 * module is required, as Expo already does on native.
 *
 * Expo's web branch requires first and loads the chunk only when that throws.
 * But outside a module factory Metro's require is guarded: a module that is not
 * defined yet goes to `ErrorUtils.reportFatalError` before anything throws. The
 * default handler rethrows, so Expo's catch still loads the chunk, but only
 * after the app's crash capture (./logging.ts) has recorded a FATAL "Requiring
 * unknown module". On web, every first lazy import (the pool, its sources, the
 * terminal) was reported as a crash.
 *
 * Loading a chunk that a `<script>` tag already ran is harmless: Metro skips a
 * module id it has already defined. Native keeps Expo's module unchanged.
 *
 * CommonJS like Expo's: Metro calls `require(<this path>)` itself as the function.
 */
const expoAsyncRequire = require('expo/internal/async-require-module')
const { loadBundleWithRecovery } = require('./lazy-chunk-recovery')

/**
 * The chunk load for `moduleID` when the import names one, else undefined.
 * @param {number} moduleID
 * @param {Record<string, unknown> | null | undefined} paths
 * @returns {Promise<void> | undefined}
 */
function loadFirst(moduleID, paths) {
  const bundle = paths?.[String(moduleID)]
  if (bundle == null) return undefined
  const load = globalThis[`${__METRO_GLOBAL_PREFIX__ ?? ''}__loadBundleAsync`]
  return load == null ? undefined : loadBundleWithRecovery(bundle, load)
}

/**
 * @param {number} moduleID
 * @param {Record<string, unknown> | null | undefined} paths
 * @param {string} [moduleName]
 */
function asyncRequire(moduleID, paths, moduleName) {
  const loading = loadFirst(moduleID, paths)
  return loading === undefined
    ? expoAsyncRequire(moduleID, paths, moduleName)
    : loading.then(() => expoAsyncRequire(moduleID, paths, moduleName))
}

/**
 * @param {number} moduleID
 * @param {Record<string, unknown> | null | undefined} paths
 */
asyncRequire.unstable_importMaybeSync = function unstable_importMaybeSync(moduleID, paths) {
  const loading = loadFirst(moduleID, paths)
  return loading === undefined
    ? expoAsyncRequire.unstable_importMaybeSync(moduleID, paths)
    : loading.then(() => expoAsyncRequire.unstable_importMaybeSync(moduleID, paths))
}
asyncRequire.prefetch = expoAsyncRequire.prefetch
asyncRequire.unstable_resolve = expoAsyncRequire.unstable_resolve
asyncRequire.unstable_createWorker = expoAsyncRequire.unstable_createWorker

module.exports = process.env.EXPO_OS === 'web' ? asyncRequire : expoAsyncRequire
