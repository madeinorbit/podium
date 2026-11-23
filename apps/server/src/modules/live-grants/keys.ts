/**
 * WHERE CORE'S LIVE GRANT KEYS COME FROM (POD-7311; POD-6954 design 4.5).
 *
 * - A key file, when `PODIUM_LIVE_GRANT_KEYS_FILE` names one: the hosted way,
 *   and allowed on self-hosted too. Every Core process reads the same file (a
 *   mounted secret) and reads it again when it changes, so a rotation needs no
 *   restart. A named file that cannot be read fails the boot. Rotation window:
 *   keep the old key about an hour plus two minutes after every Core process
 *   signs with the new one (see `@podium/live-grants` keys.ts).
 * - Hosted without a file: no key, never one minted. Grant requests answer 503
 *   until the operator configures it.
 * - Self-hosted without a file: a ring minted on first use into the install's
 *   `server_secrets`, read again every {@link DATABASE_RING_TTL_MS}, so a key an
 *   operator rotates there is picked up without a restart too.
 */

import {
  LiveGrantKeyRing,
  LiveGrantSigningUnavailable,
  mintLiveGrantKey,
  parseLiveGrantKeyRing,
} from '@podium/live-grants'
import { LiveGrantKeyFile } from '@podium/live-grants/key-file'
import { createLogger } from '@podium/logger'

const log = createLogger('server:live-grants')

export const LIVE_GRANT_KEYS_FILE_ENV = 'PODIUM_LIVE_GRANT_KEYS_FILE'

/** How long a ring read from the database is used before it is read again. */
export const DATABASE_RING_TTL_MS = 60_000

export interface LiveGrantKeySource {
  /** The ring to sign with. Throws {@link LiveGrantSigningUnavailable} when there is none. */
  ring(): Promise<LiveGrantKeyRing>
}

export interface LiveGrantKeySourceOptions {
  /** The key file's path, from {@link LIVE_GRANT_KEYS_FILE_ENV}. */
  readonly file?: string | undefined
  readonly hosted: boolean
  /** The install's secret store (`SessionStore.secrets`). */
  readonly secrets: { liveGrantKeys(opts: { mint?: () => string }): Promise<string | undefined> }
  readonly now?: () => number
}

export function liveGrantKeySource(opts: LiveGrantKeySourceOptions): LiveGrantKeySource {
  const now = opts.now ?? Date.now
  if (opts.file) {
    const file = new LiveGrantKeyFile(opts.file, {
      now,
      onError: (error) =>
        log.warn('the live grant key file changed and cannot be read; the previous keys stay', {
          error: error instanceof Error ? error.message : String(error),
        }),
    })
    if (!file.ring().signingKey()) {
      throw new LiveGrantSigningUnavailable(
        `${LIVE_GRANT_KEYS_FILE_ENV} names a file with no private key`,
      )
    }
    return { ring: async () => file.ring() }
  }
  if (opts.hosted) {
    return {
      ring: async () => {
        throw new LiveGrantSigningUnavailable(
          `live grants need ${LIVE_GRANT_KEYS_FILE_ENV} on a hosted server`,
        )
      },
    }
  }
  let cached: { ring: LiveGrantKeyRing; readAt: number } | undefined
  const mint = () => new LiveGrantKeyRing([mintLiveGrantKey()]).toJson({ includePrivate: true })
  return {
    ring: async () => {
      const at = now()
      if (cached && at - cached.readAt < DATABASE_RING_TTL_MS) return cached.ring
      const json = await opts.secrets.liveGrantKeys({ mint })
      if (json === undefined) throw new LiveGrantSigningUnavailable('no live grant key is stored')
      cached = { ring: parseLiveGrantKeyRing(json), readAt: at }
      return cached.ring
    },
  }
}
