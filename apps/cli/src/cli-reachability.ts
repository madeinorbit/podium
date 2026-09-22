/**
 * THE SETUP REACHABILITY PROBE (POD-4534): the default behind
 * `SetupDeps.checkReachability`, asking Podium Connect to probe a pasted URL
 * from the outside and say precisely why it does not work.
 *
 * WHY A DIRECT ConnectClient AND NOT THE LOCAL SERVER'S `connect.check` ROUTER.
 * `podium setup` usually runs BEFORE any server exists on this box — a fresh
 * VPS has no podium.db, no listener, and no credential yet — so there is no
 * local router to call and no authenticated tRPC caller to call it with. The
 * probe is therefore built the same way the server builds its own publisher:
 * a ConnectClient signing with the installation identity. The spinner lives
 * here (around the network flight) rather than in the flow so that an injected
 * test double stays output-clean: a "could not ask" answer is then provably
 * byte-identical to today's flow.
 *
 * "WE COULD NOT ASK" IS "NO OPINION" (undefined): Connect off
 * (PODIUM_CONNECT=off), no installation identity on this box yet (a fresh box
 * whose server has never booted — the server mints and registers the identity
 * on first boot, and setup must not mint or register anything itself), a
 * misconfigured Connect base URL, or a throw around the request. The flow
 * proceeds exactly as it does today: no warning, no extra prompt. A cloud
 * answer of CONNECT_UNAVAILABLE is the same thing one layer down and is
 * handled the same way by the caller.
 *
 * The identity load is READ-ONLY in both senses: podium.db is opened
 * `{ readOnly: true }` (opening it writable would CREATE it as a side effect
 * on a fresh box, and creating the server's database is the server's first
 * boot to do), and nothing is ever minted, registered, or published here.
 * Anything unreadable — missing file, pre-migration schema, corrupt row —
 * answers undefined rather than throwing: an optional hint must never fail
 * setup.
 */
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { connectClient } from '@podium/runtime/connect-client'
import type { CheckResult } from '@podium/runtime/connect-check'
import {
  resolveConnectBaseUrl,
  resolveConnectEnabled,
  stateDir,
} from '@podium/runtime/config'
import {
  INSTALLATION_FILE,
  INSTALLATION_META_KEY,
  INSTALLATION_PRIVATE_KEY,
  parseInstallationIdentity,
  type InstallationIdentity,
} from '@podium/runtime/installation-identity'
import { openDatabase } from '@podium/runtime/sqlite'
import type { SetupIO } from './setup-ui'

/** This box's installation identity, if it has one yet. Never throws. */
export function loadCheckIdentity(dir: string = stateDir()): InstallationIdentity | undefined {
  try {
    const db = openDatabase(join(dir, 'podium.db'), { readOnly: true })
    try {
      const meta = db
        .prepare('SELECT value FROM meta WHERE key = ?')
        .get(INSTALLATION_META_KEY) as { value: string } | undefined
      const secret = db
        .prepare('SELECT value FROM server_secrets WHERE key = ?')
        .get(INSTALLATION_PRIVATE_KEY) as { value: string } | undefined
      if (typeof meta?.value === 'string' && typeof secret?.value === 'string') {
        return parseInstallationIdentity(
          'database',
          JSON.stringify({
            ...((JSON.parse(meta.value) as Record<string, unknown> | null) ?? {}),
            privateKey: secret.value,
          }),
        )
      }
    } finally {
      db.close()
    }
  } catch {
    // No database, an unreadable one, or a pre-migration schema: the legacy
    // file below is the only other place an identity can be, and usually there
    // is simply no identity yet — all three answer "no opinion" the same way.
  }
  try {
    // A fast existence check first keeps the common fresh-box case from paying
    // for an exception; the read still races safely into the same catch.
    const path = join(dir, INSTALLATION_FILE)
    if (!existsSync(path)) return undefined
    return parseInstallationIdentity(path, readFileSync(path, 'utf8'))
  } catch {
    return undefined
  }
}

/**
 * Probe `url` from the outside via Podium Connect, with a spinner while the
 * request is in flight. `undefined` = no opinion (see above); anything else is
 * the cloud's verbatim answer for the flow to react to.
 */
export async function realCheckReachability(
  url: string,
  io: SetupIO,
): Promise<CheckResult | undefined> {
  try {
    if (!resolveConnectEnabled()) return undefined
  } catch {
    return undefined
  }
  const identity = loadCheckIdentity()
  if (!identity) return undefined
  let baseUrl: string
  try {
    baseUrl = resolveConnectBaseUrl()
  } catch {
    return undefined
  }
  const spin = io.spinner()
  spin.start('Checking that this URL is reachable from the outside…')
  try {
    return await connectClient({ baseUrl, identity: () => identity }).check(url)
  } catch {
    return undefined
  } finally {
    spin.stop()
  }
}
