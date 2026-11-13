const { withPodfile, withPodfileProperties } = require('expo/config-plugins')

const MARKER = '# @podium patched React Native source'
const PREPARE = 'prepare_react_native_project!'

/** The text-cache deadlock fix is in C++, so a prebuilt React.framework would
 * silently bypass it. Keep both clean and incremental prebuilds on source. */
function usePatchedReactNative(podfile) {
  if (podfile.includes(MARKER)) return podfile
  if (!podfile.includes(PREPARE)) {
    throw new Error('with-patched-react-native: Podfile has no React Native preparation anchor.')
  }
  return podfile.replace(
    PREPARE,
    `${MARKER}
ENV['RCT_USE_PREBUILT_RNCORE'] = '0'
ENV['RCT_USE_RN_DEP'] = '0'

${PREPARE}`,
  )
}

module.exports = function withPatchedReactNative(config) {
  config = withPodfileProperties(config, (next) => {
    next.modResults['ios.buildReactNativeFromSource'] = 'true'
    return next
  })
  return withPodfile(config, (next) => {
    next.modResults.contents = usePatchedReactNative(next.modResults.contents)
    return next
  })
}

module.exports.usePatchedReactNative = usePatchedReactNative
