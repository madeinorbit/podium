import { stateDir } from '@podium/runtime/config'
import {
  readOrCreateUpdateSigningKey,
  rotateUpdateSigningKey,
} from '@podium/runtime/update-signing-key'
import { trustDaemonUpdateKey, updateKeyFingerprint } from '@podium/runtime/update-key-trust'

const USAGE =
  'usage: podium update-key trust <base64-spki-public-key> | rotate | initialize --confirm-no-pins'

/**
 * Planned rotation preserves every existing pin through an old-key signature.
 * Lost-key recovery is separate and explicitly local to the affected daemon.
 */
export function updateKeyCliMain(args: readonly string[]): number {
  try {
    if (args[0] === 'trust' && args[1] && args.length === 2) {
      const fingerprint = trustDaemonUpdateKey(args[1], stateDir())
      console.log(`trusted publisher update key ${fingerprint}`)
      console.log('Restart the daemon to reconnect with the replacement pin.')
      return 0
    }
    if (args[0] === 'rotate' && args.length === 1) {
      const key = rotateUpdateSigningKey(stateDir())
      console.log(`rotated publisher update key to ${updateKeyFingerprint(key.publicKey)}`)
      console.log('Restart the server to advertise the signed transition.')
      return 0
    }
    if (args[0] === 'initialize' && args[1] === '--confirm-no-pins' && args.length === 2) {
      const key = readOrCreateUpdateSigningKey(stateDir(), { confirmNoPins: true })
      console.log(`initialized publisher update key ${updateKeyFingerprint(key.publicKey)}`)
      console.log('Restart the server to use it.')
      return 0
    }
    console.error(USAGE)
    return 2
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error))
    return 2
  }
}
