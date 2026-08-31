import * as Crypto from 'expo-crypto'

/**
 * Hermes ships NO `globalThis.crypto`. Web code — ours and dependencies' —
 * reasonably assumes `crypto.getRandomValues` exists everywhere, and the first
 * unguarded touch crashed the native app (a draft spawn minting a mutation id,
 * 2026-08-27 device feedback #3). expo-crypto provides both primitives natively;
 * publish them under the standard name once, before any app module runs.
 * Imported first from the root layout; web already has the real thing and is
 * left untouched.
 */
if (typeof globalThis.crypto === 'undefined') {
  ;(globalThis as { crypto?: unknown }).crypto = {
    getRandomValues: <T extends ArrayBufferView | null>(array: T): T => {
      if (array) Crypto.getRandomValues(array as unknown as Uint8Array)
      return array
    },
    randomUUID: () => Crypto.randomUUID(),
  }
}
