import { resolveMobileFile, resolveMobilePackage, resolveThroughMobileDep } from './resolve-package'

/** Checkout-local paths that make the mobile Vitest graph behave like Expo web. */
export const mobileVitestResolution = {
  assetsRegistry: resolveThroughMobileDep('react-native', '@react-native/assets-registry/registry'),
  expoFetch: resolveMobileFile('expo/src/winter/fetch/index.ts'),
  react: resolveMobilePackage('react'),
  reactDom: resolveMobilePackage('react-dom'),
  reactNativeSafeAreaContext: resolveMobileFile(
    'react-native-safe-area-context/lib/module/index.js',
  ),
  reactNativeSvg: resolveMobileFile('react-native-svg/lib/module/ReactNativeSVG.web.js'),
  reactNativeWeb: resolveMobilePackage('react-native-web'),
  inlineDependencies: [
    'react-native-gesture-handler',
    'react-native-reanimated',
    'react-native-safe-area-context',
    'react-native-worklets',
    'react-native-svg',
  ],
} as const
