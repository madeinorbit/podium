import NetInfo from '@react-native-community/netinfo'
import { AppState } from 'react-native'
import {
  type AppStateLike,
  createNativeConnectivity,
  type NativeConnectivity,
  type NetInfoLike,
} from './native-connectivity'

/**
 * THE TWO PLATFORM MODULES, and nothing else (POD-2055 WP-C2/C3).
 *
 * Every decision lives in `createNativeConnectivity`, which has no React Native
 * imports and is tested for what it decides. This file exists because that test
 * cannot import these: the unit lane runs react-native-web under happy-dom, so
 * a NetInfo import at module scope would resolve to the browser build and quietly
 * test the thing the phone does not run.
 */
export function createPlatformConnectivity(): NativeConnectivity | undefined {
  return createNativeConnectivity({
    appState: AppState as unknown as AppStateLike,
    netInfo: { addEventListener: (handler) => NetInfo.addEventListener(handler) } as NetInfoLike,
  })
}
