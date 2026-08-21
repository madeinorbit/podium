/**
 * WHAT THE TERMINAL FAMILY CAN HONESTLY CLAIM (POD-1761 W3; spec §3).
 *
 * Every field here is a declaration a consumer branches on, so every field here
 * is a place a driver could lie. The rule the whole tier rests on: a capability
 * says what this driver CAN PROVE, never what it hopes. `mayReturnUnverified:
 * true` is not an apology — it is the terminal family telling the conformance
 * corpus that an unverified send is a permitted outcome here and a bug anywhere
 * else, which is the only reason the corpus can be strict about the server
 * families at all.
 *
 * DERIVED FROM THE MANIFEST, not hand-written per harness. `AgentManifest`'s
 * `runtime.terminal` axis already declares each harness's `sendProof` order and
 * driver id (POD-2019), so this function reads that rather than restating it —
 * a second list would drift the first time a harness grew a hook channel.
 */

import { supported, unsupported } from '@podium/harness'
import type { DriverCapabilities } from '../../capabilities.js'
import type { DriverId } from '../../families.js'
import type { SendProof } from '../../turns.js'
import { VERIFICATION_WINDOW_MS } from './injection.js'

export interface TerminalCapabilityInput {
  driverId: DriverId
  /** The harness's declared proof order, from `runtime.terminal.sendProof`. */
  sendProof: readonly SendProof[]
  /** Whether this harness's driver reads a real hook channel for its
   *  interactions. Hook-sourced asks have provider identity; classified screens
   *  do not, and the difference is the whole of `atLeastOnce`. */
  interactionsFromHooks: boolean
  /** Whether composer-sync runs for this session (Draft Sync v2, POD-859). The
   *  scrape is the ONLY reason `draft.get()` can answer at all. */
  draftReadable: boolean
  /** Whether a fresh harness requires its first prompt as raw keystrokes.
   *  Attachment path prompts contain a newline between the ref and text, so
   *  they are not one atomic prompt on that path and staging must be declined. */
  usesRawFirstTurn: boolean
  /** Whether the harness reports a context-window percentage. */
  reportsContextPercent: boolean
  /**
   * Whether this harness declares a handoff transcript locator — the thing that
   * makes `export()` byte-faithful. Absent for the harnesses whose native store
   * Podium cannot yet locate, and DECLARED rather than thrown so a caller
   * degrades against a stated gap instead of an exception.
   */
  archivable: boolean
}

/**
 * The terminal family's declaration.
 *
 * READ THE `unsupported` REASONS AS COMMITMENTS. Each one names a thing this
 * epic deliberately did not build, so a consumer degrades against a stated gap
 * rather than an undefined field — and so the reason a later item has to argue
 * with is written down rather than remembered.
 */
export function terminalCapabilities(input: TerminalCapabilityInput): DriverCapabilities {
  return {
    // ---- CORE ----
    send: {
      // `steer` is ABSENT, and its absence is the point: a TUI has no way to
      // append into an open turn, so the driver degrades to `queue` and the
      // receipt's `deliveredAs` says so. Never a silent substitution.
      native: ['when-ready', 'queue', 'interrupt'],
      proof: input.sendProof,
      // TERMINAL ONLY. The permitted-failures table is what makes this checkable
      // in BOTH directions — a server driver setting it is refused by the corpus.
      mayReturnUnverified: true,
      verificationWindowMs: VERIFICATION_WINDOW_MS,
    },
    interrupt: {
      // ESC requests; the fence lands only when the causal observer reports a
      // provider-confirmed terminal event. The driver never manufactures one.
      fenceOnProviderConfirmation: true,
    },
    interactions: supported({
      kinds: input.interactionsFromHooks
        ? ['permission', 'question', 'plan-approval', 'login', 'recovery']
        : ['question', 'recovery'],
      source: input.interactionsFromHooks ? 'hook' : 'screen-classifier',
      // Answering is keystrokes into a native menu either way: even a
      // hook-SOURCED ask on Claude is answered by typing digits, and a keystroke
      // cannot prove which menu it acted on.
      answerable: 'keystroke-emulated',
      /**
       * TRUE ON BOTH SOURCES, INCLUDING THE HOOK ONE — reverted from a per-source
       * claim this driver could not keep (POD-2021 review, F2).
       *
       * The corpus permits a hook-reading terminal driver to decline this, and in
       * principle it should be able to: a causal hook gives an ask the harness's
       * own identity. This driver cannot, and the reason is specific rather than
       * a shrug. Its ask identity is the OBSERVATION's `transitionId`, which is
       * derived from `[segmentId, turnEpoch, identity, priorPhase, phase]` — a
       * PHASE-TRANSITION id, not an ask id. Two consequences on the hook path:
       *
       *   1. A menu that re-renders (`needs_user` → anything → `needs_user`)
       *      mints a second transition and therefore a second ask for one
       *      logical ask — the very re-rendered-menu weakness the table names.
       *   2. Podium subscribes BOTH `PermissionRequest` and
       *      `Notification[permission_prompt]`, and both reduce to `needs_user`
       *      with DIFFERENT summary/ask payloads, so one permission prompt can
       *      produce two observations with distinct transition ids and distinct
       *      content. No content-keyed identity collapses those two either.
       *
       * A real fix is a stable ask identity keyed on the NEED and deduped across
       * that double subscription. That belongs with W2, which owns the per-kind
       * interaction vocabulary this driver would have to key on, and it is filed
       * as a comment on POD-2021 rather than guessed at here. Until it exists,
       * declaring `false` would claim a guarantee the code does not deliver —
       * which is the failure direction the permitted-failures table exists to
       * prevent, and the more dangerous of the two: a consumer that believes
       * exactly-once stops deduping.
       */
      atLeastOnce: true,
    }),
    observation: {
      // `fine` is unclaimed: a PTY produces bytes, not token deltas, and the
      // chat degrades to complete transcript items rather than us fabricating a
      // stream out of frame boundaries.
      watchLevels: ['coarse'],
      cursorMaterial: 'file-offset',
    },
    transcript: supported({ history: true }),
    staging: input.usesRawFirstTurn
      ? unsupported('raw-first-turn harnesses cannot consume an atomic attachment path prompt')
      : supported({ kinds: ['image', 'file'], promptForm: 'path-text' }),
    // The engine terminal IS the session for this family — today's frames path,
    // described rather than replaced.
    attach: supported({ kinds: ['engine'] }),
    lease: supported({ humanTakeover: true }),
    snapshot: supported({ includesDraft: input.draftReadable }),
    archive: input.archivable
      ? supported({
          // The handoff transcript this wraps is byte-faithful to the harness's
          // own store — that is what makes a handoff resumable on the far
          // machine, and it is why the archive is deliberately NOT
          // `TranscriptItem`, which is lossy by design for display.
          formatVersion: 1,
          byteFaithful: true,
        })
      : unsupported('this harness declares no handoff transcript locator'),
    // Terminal sessions bind their resume ref from the harness's own store, which
    // for codex is written lazily. `first-turn` is the honest floor for the
    // family; a driver that has one earlier simply reports it on the binding.
    resumeRefTiming: 'first-turn',
    placement: 'dedicated',

    // ---- EXTENDED ----
    draft: input.draftReadable
      ? // WRITE IS FALSE ON PURPOSE. Composer INJECTION exists (POD-859 phase 4)
        // but routing it through the contract is a later phase; declaring it
        // now would promise a verb this driver does not implement.
        supported({ read: true, write: false })
      : unsupported('composer sync is not running for this session'),
    configure: unsupported(
      'a TUI takes its model and permission mode at launch; changing them is a relaunch',
    ),
    usage: input.reportsContextPercent
      ? supported({ perTurn: false })
      : unsupported('this harness reports no usage'),
    openUrl: supported({ intents: ['login', 'link'] }),
    title: supported({ source: 'osc' }),
    accentColor: supported(true),
  }
}
