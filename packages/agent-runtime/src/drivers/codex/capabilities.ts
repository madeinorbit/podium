/**
 * WHAT THE codex app-server DRIVER CAN HONESTLY CLAIM (POD-1761 W6; spec §3).
 *
 * ---------------------------------------------------------------------------
 * THE ONE FIELD THAT IS NEW IN THE FLEET
 * ---------------------------------------------------------------------------
 *
 * `send.native` CONTAINS `'steer'`, and this is the first driver in the epic for
 * which that is true. W5 measured that opencode has no steer verb — a prompt
 * POSTed into an open turn becomes a second turn afterwards — and added
 * `no-native-steer` to every family row as a result. Codex has `turn/steer`, it
 * was exercised live against 0.147.0 (recorded in
 * `./__fixtures__/steer-interrupt.json`), and the words joined the OPEN turn.
 *
 * That is exactly the situation the permitted-failures table was reshaped for:
 * the family row still PERMITS the weakness, and the corpus's real check is that
 * `deliveredAs` names a delivery the driver DECLARED native — in both
 * directions. So this declaration is not decoration; it is what the suite holds
 * the driver to. See ./permitted-failures.ts.
 *
 * The two fields the whole epic turns on — `send.mayReturnUnverified: false` and
 * `interactions.atLeastOnce: false` — are false here for the same reasons they
 * are false for opencode, and a server driver claiming either is refused by the
 * corpus in both directions.
 */

import { supported, unsupported } from '@podium/harness'
import type { DriverCapabilities } from '../../capabilities.js'

export function codexAppServerCapabilities(): DriverCapabilities {
  return {
    // ---- CORE ----
    send: {
      /**
       * `steer` IS PRESENT, MEASURED RATHER THAN HOPED.
       *
       * `turn/steer {threadId, expectedTurnId, input}` into a RUNNING turn
       * returns `{turnId}` and the words join that turn. The precondition is
       * real and is why the driver waits for `turn/started` before steering: the
       * turn/start RESPONSE lands before the turn is actually open, and a steer
       * fired in that window is refused with "no active turn to steer". Both
       * frames are in the fixtures.
       */
      native: ['when-ready', 'queue', 'interrupt', 'steer'],
      /** The `turn/start` response carrying a `Turn` with `status: inProgress`.
       *  Nothing else is consulted, and nothing else is needed. */
      proof: ['protocol-ack'],
      /**
       * FALSE, AND THE CORPUS CHECKS THE CONVERSE. There is no verification
       * window to fall out of: either the JSON-RPC call answered with a turn or
       * it answered an error, and both are knowable synchronously.
       */
      mayReturnUnverified: false,
    },
    interrupt: {
      // `turn/interrupt` REQUESTS the stop and answers `{}`; the fence lands
      // when Codex reports `turn/completed` with `status: 'interrupted'` — its
      // own verdict, not the driver's inference. Verified live.
      fenceOnProviderConfirmation: true,
    },
    interactions: supported({
      /**
       * TWO KINDS, BECAUSE TWO KINDS ARE WHAT CODEX ASKS through channels this
       * driver has exercised. `permission` covers all three approval requests
       * (command execution, file change, permission profile) — they are one kind
       * with three payloads, not three kinds. `elicitation` is Codex's MCP
       * channel and this is the first harness in the fleet to have one.
       *
       * `question` is NOT listed, and its absence is a measurement rather than
       * an oversight: `item/tool/requestUserInput` exists in 0.147.0's bindings
       * but never fired in any live run, and a driver that declared a kind it
       * has never seen would promise an ask it cannot produce.
       */
      kinds: ['permission', 'elicitation'],
      source: 'protocol',
      /** Answered by responding to the exact JSON-RPC request that asked — not
       *  by typing digits at a menu and hoping it was the right one. */
      answerable: 'structured',
      /** EXACTLY-ONCE. The ask IS a JSON-RPC request id; the same request never
       *  arrives twice and an answer names the request it answers. */
      atLeastOnce: false,
    }),
    observation: {
      /**
       * BOTH LEVELS, and `fine` is NATIVE here rather than filtered in user
       * space (spec §5). `optOutNotificationMethods` on the initialize handshake
       * tells the server which notifications not to send at all, so at `coarse`
       * the token deltas never cross the pipe. That is the watch-level knob the
       * spec asks for, implemented by the protocol instead of by discarding.
       *
       * The cost is that the level is fixed for the CONNECTION's life: the
       * handshake happens once. The driver therefore negotiates the level it
       * will need and reports honestly — see `watch()` in ./runtime.ts.
       */
      watchLevels: ['coarse', 'fine'],
      /** Thread id + the driver's own monotonic event ordinal, persisted as a
       *  high-water mark so a rebind resumes rather than replays. */
      cursorMaterial: 'event-offset',
    },
    transcript: supported({ history: true }),
    /**
     * `client`, not `engine`: the headless app-server remains authoritative and
     * Native launches Codex's original resume TUI beside it.
     *
     * There is no engine terminal: the session is a headless JSON-RPC child with
     * no PTY. The daemon host resumes the bound thread with `codex resume`,
     * streams that sibling PTY under the parent session id, and preserves the
     * exclusive human-controller lease while it is visible.
     *
     * The shared daemon client-terminal host implements the machine-specific
     * endpoint; a host that cannot spawn it returns the contract's typed
     * `unsupported` refusal without weakening this family-wide capability.
     */
    attach: supported({ kinds: ['client'] }),
    lease: supported({ humanTakeover: true }),
    /** The draft is Podium-owned state for this family: an app-server child has
     *  no composer to scrape, so what a snapshot carries is what was set through
     *  the contract — which is exactly why it can be carried faithfully. */
    snapshot: supported({ includesDraft: true }),
    archive: supported({
      formatVersion: 1,
      /**
       * TRUE, AND THIS IS THE ONE PLACE CODEX BEATS opencode.
       *
       * `thread/start` returns the thread's `path`: the rollout JSONL file that
       * IS the conversation, one file per thread, owned by nothing else. So the
       * archive is those exact bytes rather than a re-serialization of a message
       * tree — and `codex resume <id>` on the destination machine reads the same
       * format. W5 had to declare `false` because opencode's sessions live in a
       * SHARED sqlite database with no per-session file to copy; Codex has one,
       * so the honest answer here is the opposite one.
       */
      byteFaithful: true,
    }),
    /** `thread/start` mints the thread id before a single turn runs, so the
     *  resume ref exists from the moment the handle does — and `hibernate()`
     *  therefore never has to refuse. */
    resumeRefTiming: 'spawn',
    placement: 'dedicated',

    // ---- EXTENDED ----
    /** Read AND write: it is our own state, held beside the binding journal, so
     *  there is no scrape to be honest about. */
    draft: supported({ read: true, write: true }),
    /**
     * UNSUPPORTED, and narrowly so. `turn/start` takes per-turn `model`/`effort`
     * overrides and its doc comment says they apply "for this turn AND
     * SUBSEQUENT turns" — which would make `configure()` implementable. It is
     * not claimed because the contract's split is a spec RULE: `TurnInput
     * .overrides` is this-turn-only and `configure()` is session-sticky, and a
     * verb whose only implementation is "send a turn override and hope the next
     * turn inherits it" cannot honour that split. Claiming it would make the two
     * indistinguishable at the one layer that exists to keep them apart.
     */
    configure: unsupported(
      'model and effort are set at thread start and per turn on this driver; codex has no sticky-configuration RPC that is distinguishable from a per-turn override',
    ),
    /** Per turn, from `thread/tokenUsage/updated` — which Codex sends unprompted
     *  and which carries the model's context window, so this is the one driver
     *  that can report the used-percent without a second lookup. */
    usage: supported({ perTurn: true }),
    openUrl: unsupported('codex app-server publishes no browser-open notification'),
    /** Codex names a thread from its own conversation (`Thread.name`), and falls
     *  back to `preview` — a real title from a real source. */
    title: supported({ source: 'transcript' }),
    accentColor: unsupported('codex exposes no per-session accent'),
  }
}
