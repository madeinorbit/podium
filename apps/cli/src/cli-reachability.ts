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
 * misconfigured Connect base URL, or a throw around the request. The flow then
 * tries the URL from this machine instead. A cloud answer of CONNECT_UNAVAILABLE
 * is the same thing one layer down and is handled the same way by the caller —
 * except UNKNOWN_INSTALLATION, which only means the server's first publish has
 * not registered this box yet, so the check waits for it.
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
import { resolveConnectBaseUrl, resolveConnectEnabled, stateDir } from '@podium/runtime/config'
import type { CheckResult } from '@podium/runtime/connect-check'
import { connectClient } from '@podium/runtime/connect-client'
import {
  INSTALLATION_FILE,
  INSTALLATION_META_KEY,
  INSTALLATION_PRIVATE_KEY,
  type InstallationIdentity,
  parseInstallationIdentity,
} from '@podium/runtime/installation-identity'
import { openDatabase } from '@podium/runtime/sqlite'
import type { SetupIO } from './setup-ui'

/** This box's installation identity, if it has one yet. Never throws. */
export function loadCheckIdentity(dir: string = stateDir()): InstallationIdentity | undefined {
  try {
    const db = openDatabase(join(dir, 'podium.db'), { readOnly: true })
    try {
      const meta = db.prepare('SELECT value FROM meta WHERE key = ?').get(INSTALLATION_META_KEY) as
        | { value: string }
        | undefined
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
 * Wait (bounded) for this box's installation identity. The server mints it on its first
 * boot, and setup checks reachability right after starting that server — so on a fresh
 * install the identity appears a moment after the check would otherwise look for it.
 * Resolves either way; {@link realCheckReachability} still answers "could not ask" when
 * it never appeared.
 */
export async function waitForCheckIdentity(
  timeoutMs = 20_000,
  dir: string = stateDir(),
): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!loadCheckIdentity(dir) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 500))
  }
}

/** How long the check waits for the server's first publish to register this installation. */
const REGISTRATION_WAIT_MS = 30_000

/** Connect's answer for an installation the server has not registered yet. */
const isUnregistered = (verdict: CheckResult): boolean =>
  !verdict.ok &&
  verdict.error === 'CONNECT_UNAVAILABLE' &&
  verdict.detail === 'UNKNOWN_INSTALLATION'

/**
 * Probe `url` from the outside via Podium Connect, with a spinner while the
 * request is in flight. `undefined` = no opinion (see above); anything else is
 * the cloud's verbatim answer for the flow to react to.
 */
export async function realCheckReachability(
  url: string,
  io: SetupIO,
  opts: { waitForIdentityMs?: number; registrationWaitMs?: number } = {},
): Promise<CheckResult | undefined> {
  try {
    if (!resolveConnectEnabled()) return undefined
  } catch {
    return undefined
  }
  if (opts.waitForIdentityMs) await waitForCheckIdentity(opts.waitForIdentityMs)
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
    const client = connectClient({ baseUrl, identity: () => identity })
    // The server registers this installation with Connect on its first publish, a moment
    // after the address was handed to it; until then Connect does not know whom to check
    // for. Asked too early, that read as "could not check" (lab, 2026-10-10).
    const deadline = Date.now() + (opts.registrationWaitMs ?? REGISTRATION_WAIT_MS)
    for (;;) {
      const verdict = await client.check(url)
      if (!isUnregistered(verdict) || Date.now() >= deadline) return verdict
      await new Promise((resolve) => setTimeout(resolve, 2_000))
    }
  } catch {
    return undefined
  } finally {
    spin.stop('Asked Podium Connect to reach it from the outside.')
  }
}
