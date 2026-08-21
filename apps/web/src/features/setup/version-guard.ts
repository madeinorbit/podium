import { WIRE_RELOAD_COUNTER_KEY } from '@podium/client-core/ui-state'
import { createLogger } from '@podium/logger'
import {
  classifySkew,
  parseServerVersion,
  type ServerVersion,
  type SkewVerdict,
  WIRE_VERSION,
  wireSchemaDigest,
} from '@podium/protocol'
import { reportSkew } from '@/app/skew-notice'
import { isIterationMode } from '@/lib/iteration-mode'
import { clearReloadBudgetNote, noteReloadBudgetSpent } from '@/lib/reload-budget'

/**
 * Wire-version handshake for the web client. A cached PWA shell can outlive a server redeploy
 * that bumped the wire protocol; left alone it would speak a stale dialect to the new server.
 * On boot (and reconnect) the client fetches `/version` and, on a mismatch, HARD-reloads —
 * evicting the service worker + all caches so the browser fetches the fresh shell.
 */

/** sessionStorage key holding this tab's reload budget: how many hard-reloads it has forced,
 *  and — since POD-2253 — WHICH served build it forced them against.
 *  DELIBERATELY not in the replica's ui-state collection: this loop guard must work exactly
 *  when everything else is broken (stale shell, poisoned replica, wedged storage collections)
 *  — it runs before the store exists and must never depend on it.
 *  Spelling lives in the ui-state routing table (POD-329). */
const RELOAD_COUNTER_KEY = WIRE_RELOAD_COUNTER_KEY

const log = createLogger('web:version-guard')
/** After this many reloads AGAINST THE SAME SERVED BUILD, stop looping and surface an error. */
const MAX_RELOADS = 2

/** Result of a version check: matched, a hard-reload was triggered, or the loop guard tripped. */
export type VersionCheck = 'ok' | 'reloaded' | 'blocked' | 'server-behind' | 'iteration'

/**
 * Evict the PWA service worker + every cache, then hard-reload. Best-effort: a failure in
 * either eviction step must not prevent the reload (a plain reload still beats a wedged tab).
 */
export async function forceReload(): Promise<void> {
  try {
    const regs = await navigator.serviceWorker?.getRegistrations?.()
    if (regs) await Promise.all(regs.map((r) => r.unregister()))
  } catch {
    // best-effort: unregister failures shouldn't block the reload
  }
  try {
    if (typeof caches !== 'undefined') {
      const keys = await caches.keys()
      await Promise.all(keys.map((k) => caches.delete(k)))
    }
  } catch {
    // best-effort: cache eviction failures shouldn't block the reload
  }
  location.reload()
}

/**
 * WHICH SERVED BUILD A RELOAD IS AIMED AT (POD-2253).
 *
 * The schema digest is the precise half and the wire version is the coarse one; together they
 * are everything `/version` tells us about the build on the other end. Absent fields collapse
 * to `?`, so a server that advertises nothing is one stable target rather than a new one on
 * every poll — otherwise silence would look like perpetual change and reset the budget forever.
 */
function serverBuildKey(server: ServerVersion): string {
  return `${server.wireVersion ?? '?'}/${server.wireSchemaDigest ?? '?'}`
}

/** How many hard-reloads this tab has spent, and the build they were spent against. */
interface ReloadBudget {
  spent: number
  target: string | null
}

function readReloadBudget(): ReloadBudget {
  const none: ReloadBudget = { spent: 0, target: null }
  try {
    const raw = globalThis.sessionStorage?.getItem(RELOAD_COUNTER_KEY)
    if (!raw) return none
    // A bare integer is the PRE-POD-2253 spelling. It records attempts against a build we can
    // no longer name, and an unnameable target can never match — so it reads as an unspent
    // budget. That is the intended reading, not a tolerated one: the tabs holding one are
    // exactly the tabs this issue stranded, and the first thing a new bundle owes them is
    // another attempt.
    const parsed: unknown = JSON.parse(raw)
    if (typeof parsed !== 'object' || parsed === null) return none
    const { n, t } = parsed as { n?: unknown; t?: unknown }
    const spent = typeof n === 'number' && Number.isFinite(n) && n > 0 ? Math.floor(n) : 0
    return { spent, target: typeof t === 'string' ? t : null }
  } catch {
    return none
  }
}

function writeReloadBudget(budget: ReloadBudget): void {
  try {
    globalThis.sessionStorage?.setItem(
      RELOAD_COUNTER_KEY,
      JSON.stringify({ n: budget.spent, t: budget.target }),
    )
  } catch {
    // sessionStorage may be unavailable (private mode) — the loop guard degrades gracefully
  }
}

function clearReloadCounter(): void {
  try {
    globalThis.sessionStorage?.removeItem(RELOAD_COUNTER_KEY)
  } catch {
    // ignore — nothing to clear if storage is unavailable
  }
}

/**
 * What to say when an iterate page does not match the server it is proxying to.
 *
 * NAME THE RIGHT MISMATCH. The common case on a VPS is `schema-skew` — the
 * installed server was built from an older commit than the branch being
 * iterated on, so the wire VERSIONS agree and only the schema digest differs.
 * A message about wire numbers there reads "wire 2 against this bundle's 2",
 * which is the sentence that sends someone looking for a bug in the numbers.
 */
export function iterationSkewMessage(verdict: SkewVerdict): string {
  const lead = 'ITERATION MODE: this page is the web UI from source'
  const tail =
    'Reloading cannot fix it — the fresh bundle is the same source. Release your server-side ' +
    'changes through a dev release, or keep to UI-only work.'
  if (verdict === 'schema-skew') {
    return `${lead}, and the installed server it talks to was built from a different commit, so
      the two disagree about the wire schema. Some data it sends may not decode. ${tail}`
      .replace(/\s+/g, ' ')
      .trim()
  }
  return `${lead}, and it speaks a ${verdict === 'client-too-new' ? 'newer' : 'older'} wire
    protocol than the installed server it talks to. ${tail}`
    .replace(/\s+/g, ' ')
    .trim()
}

/**
 * Fetch the server's `/version` and hard-reload when this cached bundle is out of sync with it:
 * either the bundle predates the server's `minSupportedVersion`, or the two `wireVersion`s differ.
 *
 * - Matched → `'ok'`, clears the loop counter.
 * - Mismatch → `forceReload()`, returns `'reloaded'` (the page is now reloading).
 * - Mismatch persisting after `MAX_RELOADS` reloads AT THE SAME SERVED BUILD → `'blocked'`
 *   (logged), no reload, so a broken deploy can't spin the tab in an endless reload loop. A
 *   server that starts serving a different build resets the budget (POD-2253).
 * - Mismatch in ITERATION MODE → `'iteration'`, never a reload: the page is source and the
 *   fresh bundle would be the same source (POD-2513).
 * - Network / parse error → `'ok'` (never block the app on a flaky `/version`).
 */
export async function checkServerVersion(
  httpOrigin: string,
  /** Injected for the test; production reads the build define. */
  iterating: boolean = isIterationMode(),
): Promise<VersionCheck> {
  let server: ReturnType<typeof parseServerVersion>
  try {
    const res = await fetch(`${httpOrigin}/version`)
    server = parseServerVersion(await res.json())
  } catch {
    return 'ok' // unreachable or non-JSON /version → proceed rather than block
  }

  const verdict = classifySkew(server, { wire: WIRE_VERSION, digest: wireSchemaDigest() })

  if (verdict === 'ok') {
    clearReloadCounter()
    // The mismatch resolved, so the explanation about a spent budget would now
    // be describing a problem that no longer exists.
    clearReloadBudgetNote()
    return 'ok'
  }

  /**
   * ITERATION MODE (POD-2513, spec §7): this page is SOURCE, served by
   * `bun run iterate` in front of the installed server. A mismatch here is the
   * expected state of any branch that has touched the protocol, and it is the
   * one mismatch a reload provably cannot fix — the fresh bundle is the same
   * source. Reloading would burn both attempts and then report the SERVED build
   * as stale, which is the wrong diagnosis about the wrong build. Say what is
   * actually true and leave the budget untouched, so a tab that later loads the
   * installed app starts with a full one.
   *
   * The check sits after the `ok` branch on purpose: a matching iterate page is
   * simply fine, and nothing about this mode should suppress that.
   */
  if (iterating) {
    reportSkew({ source: 'boot-digest', severe: false, message: iterationSkewMessage(verdict) })
    return 'iteration'
  }

  /**
   * This client is AHEAD of its server. A reload cannot fix that: the fresh
   * bundle would be just as far ahead. Reloading here would burn both attempts
   * and then tell the user to rebuild, which is the wrong instruction. The thing
   * to move is the server, so say so and leave the reload budget alone.
   */
  if (verdict === 'client-too-new') {
    reportSkew({
      source: 'boot-digest',
      severe: false,
      message:
        `Your server is running an older version of Podium than this app ` +
        `(wire ${server.wireVersion} against ${WIRE_VERSION}). Update your server to continue.`,
    })
    return 'server-behind'
  }

  const serverWire = server.wireVersion
  const serverMin = server.minSupportedVersion

  /**
   * A RELOAD BUDGET IS SPENT AGAINST ONE SERVED BUILD (POD-2253).
   *
   * The loop this budget exists to stop is a tab reloading over and over at a server that keeps
   * handing back the SAME stale build — two attempts prove the served bytes are the problem and
   * a third would prove nothing. A build the tab has never seen before is the opposite: it is
   * new evidence, and the eviction that failed against the old one has never been tried against
   * this one. So the budget is keyed to the target, and a genuinely different digest earns a
   * full budget rather than inheriting a spent one.
   *
   * That distinction is the whole of this issue. The first update onto the operation design
   * changed the wire digest, which is exactly when the old bundle most needs the guard — and it
   * met a budget already emptied by an earlier, unrelated mismatch, so the tab stayed dead.
   */
  const target = serverBuildKey(server)
  const budget = readReloadBudget()
  const reloads = budget.target === target ? budget.spent : 0
  if (reloads >= MAX_RELOADS) {
    log.error('wire-version mismatch persists; not reloading again', {
      reloads,
      target,
      bundleWire: WIRE_VERSION,
      serverWire,
      serverMin,
    })
    // The loop guard has tripped, so reloading is off the table and this bundle
    // is going to run against a server it does not match. SAY SO — that silence
    // is the whole of POD-1610. The wording avoids "reload": two have already
    // happened and neither worked, which means the SERVED build is stale.
    //
    // The banner is the backstop; the EXPLANATION belongs in the update panel,
    // which is the one place that knows what the update is doing (POD-2102,
    // spec §6.2.3). Record the spent budget here — the panel reads it after the
    // reload that this note is about.
    noteReloadBudgetSpent()
    reportSkew({
      source: 'boot-digest',
      severe: false,
      message:
        'Podium’s server and this page are using different app builds. ' +
        'Some information may be missing. Open the update panel to finish updating.',
    })
    return 'blocked'
  }
  writeReloadBudget({ spent: reloads + 1, target })
  await forceReload()
  return 'reloaded'
}

/**
 * THE TAB THAT CANNOT PRESS ITS OWN BUTTON (POD-2253).
 *
 * `checkServerVersion` runs at boot, which covers the tab that is opened after an update. It
 * does nothing for the tab that was ALREADY open when the server swapped build underneath it —
 * and that tab is the bad case, because the first thing a wire-schema change breaks is the
 * app's ability to decode anything, which is to say its ability to be clicked. Today all it
 * gets is a banner telling it to reload: a sentence addressed to a surface that no longer works.
 *
 * The transport's refused frames are proof, not suspicion — this bundle could not read what
 * this server sent. So re-run the handshake, and if `/version` agrees the build genuinely
 * changed, force the takeover rather than asking. When the digests MATCH, the skew is something
 * other than a stale shell (a broken build, a bad frame) and a reload would be a guess, so this
 * stays out of the way and leaves the banner to say so.
 *
 * `refusedFrames === 0` is deliberately not enough. A quarantined row means one item did not
 * decode; whole refused frames mean the bundle is the wrong one. Only the second justifies
 * taking a running tab away from its user.
 *
 * Once per page load: the transport reports skew per frame, and the reload is already in flight
 * by the second one.
 */
let recoveryAttempted = false

export async function recoverFromWireSkew(
  httpOrigin: string,
  skew: { refusedFrames: number },
): Promise<VersionCheck | 'ignored'> {
  if (skew.refusedFrames <= 0 || recoveryAttempted) return 'ignored'
  recoveryAttempted = true
  return await checkServerVersion(httpOrigin)
}

/** Test-only: the once-per-page latch outlives a test file's cases. */
export function resetWireSkewRecovery(): void {
  recoveryAttempted = false
}
