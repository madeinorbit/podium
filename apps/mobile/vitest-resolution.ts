import { resolveMobileFile, resolveMobilePackage, resolveThroughMobileDep } from './resolve-package'

/** Checkout-local paths that make the mobile Vitest graph behave like Expo web. */
export const mobileVitestResolution = {
  assetsRegistry: resolveThroughMobileDep('react-native', '@react-native/assets-registry/registry'),
  expoFetch: resolveMobileFile('expo/src/winter/fetch/index.ts'),
  expoModulesCore: resolveMobileFile('expo-modules-core'),
  mobxReactLite: resolveMobileFile('mobx-react-lite/dist/mobxreactlite.mjs'),
  react: resolveMobilePackage('react'),
  reactDom: resolveMobilePackage('react-dom'),
  reactNativeSafeAreaContext: resolveMobileFile(
    'react-native-safe-area-context/lib/module/index.js',
  ),
  reactNativeSvg: resolveMobileFile('react-native-svg/lib/module/ReactNativeSVG.web.js'),
  reactNativeWeb: resolveMobilePackage('react-native-web'),
  inlineDependencies: [
    // Shared model observers must use the same mobile React dispatcher as
    // their renderer. External CJS would resolve the workspace development peer.
    'mobx-react-lite',
    'react-native-gesture-handler',
    'react-native-reanimated',
    'react-native-safe-area-context',
    'react-native-worklets',
    'react-native-svg',
  ],
} as const
