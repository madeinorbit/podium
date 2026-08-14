/**
 * WHAT THE opencode SERVER DRIVER CAN HONESTLY CLAIM (POD-1761 W5; spec §3).
 *
 * ---------------------------------------------------------------------------
 * THE TWO FIELDS THE WHOLE EPIC TURNS ON
 * ---------------------------------------------------------------------------
 *
 * `send.mayReturnUnverified: false` and `interactions.atLeastOnce: false`. Those
 * are the two weaknesses the permitted-failures table reserves to the terminal
 * family, and a server driver setting either is refused by the corpus — in both
 * directions, which is what makes the claim mean something. This driver can hold
 * them because it has what a PTY does not: a 204 from `prompt_async` is a
 * protocol acknowledgement that opencode took the turn, and a `per_…`/`que_…`
 * request id is a real ask identity that a REST reply answers exactly once.
 *
 * Everything else below is read the same way: a capability says what this driver
 * CAN PROVE, never what it hopes.
 */

import { supported, unsupported } from '@podium/harness'
import type { DriverCapabilities } from '../../capabilities.js'

export function opencodeServerCapabilities(): DriverCapabilities {
  return {
    // ---- CORE ----
    send: {
      /**
       * `steer` IS ABSENT, MEASURED RATHER THAN ASSUMED.
       *
       * opencode 1.18.16: a prompt POSTed while a turn is open returns its 204
       * immediately, but the words become a SECOND user message and a SECOND
       * assistant turn that runs once the first completes. That is a queue, and
       * calling it `steer` would make `deliveredAs` — the one field that exists
       * to prevent silent substitution — the place the substitution happened.
       * The driver degrades to `queue` and says so.
       */
      native: ['when-ready', 'queue', 'interrupt'],
      /** The 204. Nothing else is consulted, and nothing else is needed. */
      proof: ['protocol-ack'],
      /**
       * FALSE, AND THE CORPUS CHECKS THE CONVERSE. There is no verification
       * window here to fall out of: either opencode accepted the POST or it
       * answered a status, and both are knowable synchronously. The plan's
       * sentence is the test — "there is NO `unverified` here; if you find
       * yourself wanting it, your mapping is wrong."
       */
      mayReturnUnverified: false,
    },
    interrupt: {
      // `POST /session/{id}/abort` REQUESTS the stop; the fence lands when
      // opencode reports the turn actually ended (`session.idle`). The driver
      // never manufactures one, which is why `interrupt()` returns nothing to
      // await.
      fenceOnProviderConfirmation: true,
    },
    interactions: supported({
      /**
       * TWO KINDS, BECAUSE TWO KINDS ARE WHAT opencode ASKS. `permission.asked`
       * and `question.asked` were both round-tripped against a live server. The
       * other four in the vocabulary (plan-approval, elicitation, login,
       * recovery) have no opencode channel, and listing them would claim asks
       * this driver can never produce and could not answer if it did.
       */
      kinds: ['permission', 'question'],
      source: 'protocol',
      /** Answered over REST against the harness's own request id — not by
       *  typing digits at a menu and hoping it was the right one. */
      answerable: 'structured',
      /** EXACTLY-ONCE. `per_…`/`que_…` are opencode's ids; the same ask never
       *  arrives twice and an answer names the ask it answers. */
      atLeastOnce: false,
    }),
    observation: {
      /**
       * BOTH LEVELS, and `fine` is real rather than aspirational:
       * `message.part.delta` carries token fragments today. They are keyed by
       * the part's stamped cursor so a consumer can reconcile a fragment stream
       * against the `complete` item that closes it — see `deltaItemIdOf` in
       * ./map.ts for why the item's `id` cannot be that key.
       */
      watchLevels: ['coarse', 'fine'],
      /** Session id + the driver's own monotonic event ordinal, persisted as a
       *  high-water mark so a reconnect resumes rather than replays. */
      cursorMaterial: 'event-offset',
    },
    transcript: supported({ history: true }),
    /**
     * `client`, not `engine`. There is no engine terminal — the session is a
     * server process with no PTY — and opencode ships its own TUI client
     * (`opencode attach <url>`) that connects to exactly this server. That is
     * the server family's variant in the spec, and it is the one this driver
     * produces.
     */
    attach: supported({ kinds: ['client'] }),
    lease: supported({ humanTakeover: true }),
    /** The draft is Podium-owned state for this family: opencode's server has no
     *  composer to scrape, so what a snapshot carries is what was set through
     *  the contract — which is exactly why it can be carried faithfully. */
    snapshot: supported({ includesDraft: true }),
    archive: supported({
      formatVersion: 1,
      /**
       * FALSE, DELIBERATELY, AND HERE IS WHAT IT COSTS.
       *
       * The archive is the session's messages-and-parts as opencode's own
       * `export`/`import` pair speaks them — enough to resume the CONVERSATION
       * on another machine with the same harness, which is the archive
       * guarantee the contract actually makes. It is NOT the sqlite pages, so
       * it does not carry opencode's own row identity, its snapshot refs
       * (`step-start`'s git object ids point at a local object store) or
       * anything else outside the message tree. Full byte fidelity would mean
       * shipping a per-session slice of a SHARED database, and that database is
       * shared with every other opencode session on the machine — there is no
       * per-session file to copy. Bounded scope, stated rather than discovered.
       */
      byteFaithful: false,
    }),
    /** `POST /session` mints `ses_…` before a single turn runs, so the ref
     *  exists from the moment the handle does — and `hibernate()` therefore
     *  never has to refuse. */
    resumeRefTiming: 'spawn',
    placement: 'dedicated',

    // ---- EXTENDED ----
    /** Read AND write: it is our own state, held beside the binding journal, so
     *  there is no scrape to be honest about. */
    draft: supported({ read: true, write: true }),
    configure: unsupported(
      'model and permission mode are pinned at session create and per turn; the sticky switch routes are v2-only and were not exercised against a live server, so this driver does not claim them',
    ),
    /** Per assistant message, from the tokens/cost opencode puts on the message
     *  itself. `contextUsedPercent` is absent: it needs the model's context
     *  limit, which this driver does not read. */
    usage: supported({ perTurn: true }),
    openUrl: unsupported('opencode publishes no browser-open event on its SSE stream'),
    /** opencode names a session from its own conversation — a real title from a
     *  real source, unlike a synthetic one. */
    title: supported({ source: 'transcript' }),
    accentColor: unsupported('opencode exposes no per-session accent'),
  }
}
