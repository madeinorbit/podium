/** Platform policy and crypto for the shared pairing protocol. Screens stay here. */

import {
  claimMobilePairing as claim,
  type MobilePairingEnvelope,
  preflightServer as preflight,
} from '@podium/client-core/accounts/pairing'
import * as Crypto from 'expo-crypto'
import { Platform } from 'react-native'
import { startupTiming } from '../lib/startup-timing'

export * from '@podium/client-core/accounts/pairing'

export function preflightServer(httpOrigin: string, workspaceId?: string) {
  return startupTiming.measure('profile.preflight', () =>
    preflight(httpOrigin, workspaceId, {
      native: Platform.OS !== 'web',
      allowDevelopmentLan:
        (typeof __DEV__ !== 'undefined' && __DEV__) ||
        process.env.EXPO_PUBLIC_ALLOW_CLEARTEXT === '1',
    }),
  )
}

export function claimMobilePairing(
  envelope: Extract<MobilePairingEnvelope, { mode: 'pair' }>,
  deviceId: string,
  deviceName: string,
  platform: string,
) {
  return claim(envelope, deviceId, deviceName, platform, {
    randomBytes: (length) => Crypto.getRandomBytes(length),
    sha256: (bytes) => Crypto.digest(Crypto.CryptoDigestAlgorithm.SHA256, bytes),
  })
}
