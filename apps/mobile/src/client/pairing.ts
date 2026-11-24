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

/**
 * ONE CLAIM PER PAIRING CODE (POD-2364). The server deletes a code on its first
 * successful claim and answers any later claim with 400 "Pairing is
 * unavailable". A link processed twice, or a setup screen that remounted, made
 * a second claim and failed a pairing that had already succeeded. Every caller
 * for the same code shares the first claim; a failed claim is forgotten so a
 * retry asks again.
 */
const claims = new Map<string, Promise<Awaited<ReturnType<typeof claim>>>>()

export function claimMobilePairing(
  envelope: Extract<MobilePairingEnvelope, { mode: 'pair' }>,
  deviceId: string,
  deviceName: string,
  platform: string,
) {
  const held = claims.get(envelope.pairCode)
  if (held) return held
  const pending = claim(envelope, deviceId, deviceName, platform, {
    randomBytes: (length) => Crypto.getRandomBytes(length),
    sha256: (bytes) => Crypto.digest(Crypto.CryptoDigestAlgorithm.SHA256, bytes),
  })
  claims.set(envelope.pairCode, pending)
  pending.catch(() => {
    if (claims.get(envelope.pairCode) === pending) claims.delete(envelope.pairCode)
  })
  return pending
}

/** A denied claim is spent: the next attempt with this code must ask the server again. */
export function forgetMobilePairingClaim(pairCode: string): void {
  claims.delete(pairCode)
}
