/**
 * ONE READER FOR ONE DAEMON SENTENCE (POD-2241).
 *
 * ---------------------------------------------------------------------------
 * THE DEFECT THIS FILE EXISTS TO CLOSE
 * ---------------------------------------------------------------------------
 *
 * A machine that cannot take an update says so in a sentence. That sentence
 * used to be read TWICE, by two functions that did not know about each other:
 * `classifyMachineFailure` in apps/server, which turns it into a code the
 * operation persists, and `describeUpdateFailure` in apps/web, which turns it
 * into the words an operator reads. Adding an arm to one was therefore only
 * ever HALF a fix — and the missing half did not produce a blank, it produced a
 * confident wrong answer, because both readers fell through to "this machine
 * stopped responding and will resume when it reconnects".
 *
 * That is the worst possible default for this family. Almost every sentence in
 * the table below is written by a daemon that is RUNNING, ANSWERING, and
 * declining on purpose — so the fall-through sent the operator to go and check
 * the healthiest thing in the picture, and promised a recovery ("it will
 * resume") that nothing was ever going to deliver.
 *
 * The epic hit it twice before this file existed: POD-2210 (the foreground
 * all-in-one refusal, classified as unreachable until an arm was added) and
 * POD-2239/POD-2240 (the same thing again, three schema tokens at a time). A
 * by-import audit then found ELEVEN more sentences in the same hole — every git
 * delivery step, both verification failures, every delivery misconfiguration,
 * both boot-reconciliation verdicts, and an HTTP status from the artifact
 * download.
 *
 * ---------------------------------------------------------------------------
 * WHY A TABLE IN THE LEAF PACKAGE, AND NOT A CONVENTION
 * ---------------------------------------------------------------------------
 *
 * A comment asking the next person to remember both sides is not an instrument
 * that can say no — this epic has now found nine gates that could not. So the
 * classification lives HERE, in the one package both readers already depend on,
 * and there is exactly one of it:
 *
 *  - {@link classifyUpdateFailureDetail} is the ONLY place a sentence becomes a
 *    code. apps/server calls it; apps/web calls it. Neither re-derives it.
 *  - Every code in {@link MachineFailureCode} must be answered by BOTH
 *    consumers, and TypeScript is what enforces that: the server's failure
 *    union is switched on without a default, and the web's copy table is a
 *    `Record<MachineFailureCode, …>`. Adding a row below reds both packages
 *    until both have said what it means.
 *
 * So the failure mode is now a build error rather than a wrong sentence in a
 * dialog nobody can argue with.
 *
 * ---------------------------------------------------------------------------
 * TOKENS ARE FINER THAN CODES, DELIBERATELY
 * ---------------------------------------------------------------------------
 *
 * A token names WHAT THE PRODUCER SAID (`git-fetch-failed`); a code names WHAT
 * THE OPERATOR SHOULD DO ABOUT IT (`machine-delivery-failed`). Several tokens
 * legitimately share a code — six git steps have one next action between them —
 * and keeping them apart at the token layer is what lets the raw detail stay
 * useful as a diagnostic while the copy stays short.
 */

/**
 * What an operator is being told, and therefore what copy is owed.
 *
 * Open at the wire (a newer server may send a code this bundle predates, and
 * the renderer degrades to the server's own sentence), closed in this package:
 * both consumers switch on it exhaustively.
 */
export type MachineFailureCode =
  /** The machine's checkout is not clean, so git delivery would not be safe. */
  | 'machine-dirty-checkout'
  /** No artifact this machine can use: wrong platform, or no offered delivery. */
  | 'machine-unsupported'
  /** The machine went quiet. THE ONLY MEMBER THAT MEANS "NOT ANSWERING". */
  | 'machine-unreachable'
  /** Server and daemon share one PID with nothing to restart it (POD-2210). */
  | 'machine-cannot-restart'
  /** Its database has applied a migration the target does not define. */
  | 'machine-schema-advanced'
  /** The target did not declare a schema and could not be proved newer. */
  | 'machine-schema-unknown'
  /** Its database could not be read, so nothing about the target is known. */
  | 'machine-schema-unreadable'
  /** A delivery step failed on a live machine. Retrying is reasonable. */
  | 'machine-delivery-failed'
  /** This update cannot be delivered to this machine as configured. Retry won't help. */
  | 'machine-delivery-unavailable'
  /** The package failed digest or signature verification and was refused. */
  | 'machine-artifact-rejected'
  /** It restarted but did not come back on the target version. */
  | 'machine-update-not-confirmed'
  /** The server retracted the target while this machine was mid-flight. */
  | 'update-withdrawn'
  /** The bytes could not be fetched. Not a statement about the machine. */
  | 'download-failed'

interface UpdateFailureMatcher {
  readonly token: string
  readonly pattern: RegExp
  readonly code: MachineFailureCode
  /**
   * A sentence a real producer really writes for this token — trimmed where a
   * refusal runs to a paragraph, but never paraphrased.
   *
   * This is what lets the two CONSUMERS be tested without importing an app they
   * are not allowed to import: apps/server and apps/web drive their coverage
   * off these, and `apps/daemon/src/refusal-tokens.test.ts` drives the real
   * constructors and asserts they land on the same token. So the examples are
   * pinned to what the system produces rather than to what anyone imagined it
   * produces — which is how POD-2238 and POD-2240 were both found.
   */
  readonly example: string
}

/**
 * ORDERED, FIRST MATCH WINS. The order is part of the contract:
 *
 *  - The four first-person refusals lead, because they are the most specific
 *    and the generic delivery copy below would swallow them into "one or more
 *    machines cannot use this update" — untrue and unactionable for a daemon
 *    that is alive and declining on purpose.
 *  - `schema-unreadable` carries the underlying read error VERBATIM, and an
 *    arbitrary errno is exactly the kind of text the download family below is
 *    built to catch. It must be classified before that family gets a look.
 *  - The git steps are anchored to their `git delivery failed:` prefix, so
 *    `fetch-failed` there can never be confused with the `fetch failed` of a
 *    browser network error two rows down.
 *  - `git-timed-out` precedes `download-timed-out` for the same reason.
 *
 * Every pattern below is pinned by a test that calls the REAL producer and
 * asserts the token — `apps/daemon/src/refusal-tokens.test.ts` for the daemon
 * and delivery constructors, `operation.test.ts` for the server's own details.
 * Hand-written fixtures are how a pattern drifts away from the sentence it was
 * written for without anything going red.
 */
const UPDATE_FAILURE_MATCHERS = [
  // --- what the SERVER said about a machine --------------------------------
  {
    /**
     * FIRST, AND ANCHORED, because this is the one detail that WRAPS ARBITRARY
     * PROSE: `setTargetUnavailable` composes its reason from the development
     * publisher, and a real one reads "The source checkout has 2 uncommitted
     * changes." Left further down the list, the word `uncommitted` in the
     * SERVER's checkout was read as the MACHINE's dirty working tree, and the
     * operator was told to go and commit files on a machine that had none.
     *
     * A prefix rather than a substring for the same reason: anything after the
     * colon is someone else's sentence and must not be able to claim a token.
     */
    token: 'update-withdrawn',
    pattern: /^update-withdrawn:/i,
    code: 'update-withdrawn',
    example: 'update-withdrawn: The source checkout has 2 uncommitted changes.',
  },

  // --- a daemon that is alive and declining on purpose ----------------------
  {
    token: 'foreground-all-in-one',
    pattern: /foreground[-_\s]all[-_\s]in[-_\s]one/i,
    code: 'machine-cannot-restart',
    example:
      'cannot converge: foreground-all-in-one — this daemon shares its process with the ' +
      'Podium server and nothing would start that process again, so updating it here would ' +
      'stop the server and it would not come back',
  },
  {
    token: 'schema-advanced',
    pattern: /schema[-_\s]advanced/i,
    code: 'machine-schema-advanced',
    example:
      "cannot converge: schema-advanced — this machine's database has applied migration " +
      "'0042_add_operations' (and 2 more), which 0.1.3 does not define, so that build would " +
      'refuse to open the database and the server would not come back.',
  },
  {
    token: 'schema-unknown',
    pattern: /schema[-_\s]unknown/i,
    code: 'machine-schema-unknown',
    example:
      'cannot converge: schema-unknown — 0.1.5 does not declare which schema migrations it can ' +
      'open, it is not a version this machine can prove is newer than the dev+abc1234 it runs.',
  },
  {
    token: 'schema-unreadable',
    pattern: /schema[-_\s]unreadable/i,
    code: 'machine-schema-unreadable',
    example:
      "cannot converge: schema-unreadable — this machine's database could not be read " +
      '(SQLITE_BUSY: database is locked), so there is no way to tell whether 0.1.5 could open it.',
  },

  // --- what the machine's own checkout said ---------------------------------
  {
    token: 'dirty-working-tree',
    pattern: /dirty[-_\s]working[-_\s]tree|local (?:files|edits)|uncommitted/i,
    code: 'machine-dirty-checkout',
    example: 'git delivery failed: dirty-working-tree',
  },

  // --- what the convergence planner refused --------------------------------
  {
    token: 'no-artifact',
    pattern: /no[-_\s]artifact/i,
    code: 'machine-unsupported',
    example: 'cannot converge: no-artifact',
  },
  {
    token: 'unsupported-delivery',
    pattern: /unsupported[-_\s]delivery/i,
    code: 'machine-unsupported',
    example: 'cannot converge: unsupported-delivery',
  },
  {
    token: 'unsupported-platform',
    pattern: /unsupported[-_\s]platform/i,
    code: 'machine-unsupported',
    example: 'cannot converge: unsupported-platform',
  },

  // --- what a git delivery step said ---------------------------------------
  {
    token: 'invalid-git-reference',
    pattern: /invalid[-_\s]git[-_\s]reference/i,
    code: 'machine-delivery-unavailable',
    example: 'git delivery failed: invalid-git-reference',
  },
  {
    token: 'git-status-failed',
    pattern: /git delivery failed:\s*status[-_\s]failed/i,
    code: 'machine-delivery-failed',
    example: 'git delivery failed: status-failed',
  },
  {
    token: 'git-fetch-failed',
    pattern: /git delivery failed:\s*fetch[-_\s]failed/i,
    code: 'machine-delivery-failed',
    example: 'git delivery failed: fetch-failed',
  },
  {
    token: 'git-checkout-failed',
    pattern: /git delivery failed:\s*checkout[-_\s]failed/i,
    code: 'machine-delivery-failed',
    example: 'git delivery failed: checkout-failed',
  },
  {
    token: 'git-timed-out',
    pattern: /git delivery failed:\s*timed[-_\s]out/i,
    code: 'machine-delivery-failed',
    example: 'git delivery failed: timed-out',
  },
  {
    /**
     * Belt and braces. `applyGrant` returns without reporting when its own
     * signal is aborted, so today this sentence cannot reach an operator — the
     * daemon's token test pins that too. It is here anyway because
     * "unreportable" is a property of one call site, and the cost of covering
     * it is one row.
     */
    token: 'git-cancelled',
    pattern: /git delivery failed:\s*cancelled/i,
    code: 'machine-delivery-failed',
    example: 'git delivery failed: cancelled',
  },

  // --- what the artifact fetch said ----------------------------------------
  {
    /**
     * A SECURITY EVENT, and the reason it must never share the unreachable
     * default: an artifact whose digest or signature did not verify is either
     * corrupt or tampered with, and "check the machine is running" is the one
     * response that leaves the operator none the wiser.
     */
    token: 'artifact-unverified',
    pattern: /(?:digest|signature) verification FAILED/i,
    code: 'machine-artifact-rejected',
    example: 'digest verification FAILED — refusing to install the artifact',
  },
  {
    token: 'delivery-misconfigured',
    /**
     * The first two alternatives are RETIRED PRODUCERS kept for daemons that
     * predate the delivery-kind retirement (see {@link RETIRED_PRODUCER_TOKENS}).
     * The live producers are the last two, in `update-delivery.ts`.
     */
    pattern:
      /(?:git delivery requires a configured checkout runner|platform delivery requires an artifact URL|bundle delivery requires the server update key|feed delivery requires an artifact URL|this target requires the server update key)/i,
    code: 'machine-delivery-unavailable',
    example: 'feed delivery requires an artifact URL',
  },
  {
    token: 'download-http-status',
    pattern: /artifact download returned \d+/i,
    code: 'download-failed',
    example: 'artifact download returned 404',
  },
  {
    token: 'download-timed-out',
    pattern: /download timed out|artifact download timed out/i,
    code: 'download-failed',
    example: 'artifact download timed out after 300s',
  },
  {
    token: 'download-unreachable',
    pattern:
      /unable to connect|access the url|failed to fetch|fetch failed|download failed|network(?:error| request failed)|econn(?:refused|reset)|etimedout|enotfound/i,
    code: 'download-failed',
    example: 'fetch failed',
  },

  // --- what the machine said after it restarted ----------------------------
  {
    /**
     * The boot reconciler's two verdicts. The machine is UP — it is the boot
     * that is reporting — so the unreachable default was false on its face, and
     * its "will resume when it reconnects" described a reconnection that had
     * already happened.
     */
    token: 'convergence-attempts-exhausted',
    pattern: /pinned to last[-_\s]known[-_\s]good/i,
    code: 'machine-update-not-confirmed',
    example: 'did not reach 0.1.5 after 2 attempt(s); running 0.1.3, pinned to last-known-good',
  },
  {
    token: 'convergence-retry-pending',
    pattern: /applying again will retry it/i,
    code: 'machine-update-not-confirmed',
    example: 'attempt 1 of 2 did not reach 0.1.5 (running 0.1.3); applying again will retry it',
  },

  // --- the one sentence that really does mean "not answering" ---------------
  {
    token: 'stopped-reporting-progress',
    pattern: /stopped reporting progress/i,
    code: 'machine-unreachable',
    example: 'The machine stopped reporting progress while updating.',
  },
] as const satisfies readonly UpdateFailureMatcher[]

/** Every token a producer in this system can put in front of an operator. */
export type UpdateFailureToken = (typeof UPDATE_FAILURE_MATCHERS)[number]['token']

/** The token list, in match order. Exported so a test can assert coverage. */
export const UPDATE_FAILURE_TOKENS: readonly UpdateFailureToken[] = UPDATE_FAILURE_MATCHERS.map(
  (matcher) => matcher.token,
)

/** The code each token resolves to, for tests and for anyone auditing the table. */
export const CODE_FOR_UPDATE_FAILURE_TOKEN = Object.fromEntries(
  UPDATE_FAILURE_MATCHERS.map((matcher) => [matcher.token, matcher.code]),
) as Record<UpdateFailureToken, MachineFailureCode>

/**
 * One real sentence per token, for the consumers that cannot import the app
 * that writes it (apps/server and apps/web may not import apps/daemon).
 *
 * These are not fixtures in the usual sense: `apps/daemon/src/refusal-tokens.test.ts`
 * drives the actual constructors and asserts each one lands on the token whose
 * example is quoted here, so a producer that rewords its refusal reds the
 * daemon suite rather than quietly leaving a pattern matching nothing.
 */
export const UPDATE_FAILURE_EXAMPLES = Object.fromEntries(
  UPDATE_FAILURE_MATCHERS.map((matcher) => [matcher.token, matcher.example]),
) as Record<UpdateFailureToken, string>

/**
 * TOKENS THAT OUTLIVED THEIR PRODUCER, named rather than left to drift.
 *
 * The `git` and `bundle` delivery kinds were retired when `dev` became a pulled
 * feed (spec §1, disposition 5), so nothing in THIS build writes these
 * sentences any more. The rows stay because the wire is older than the build:
 * a fleet machine still running a daemon from before the retirement can report
 * one, and dropping the pattern would send that refusal straight back into
 * `machine-unreachable` — the exact defect this whole table exists to prevent.
 *
 * Listed here so the honesty check in `apps/daemon/src/refusal-tokens.test.ts`
 * stays a ratchet. That test drives every token from a REAL constructor; a
 * token with no producer would otherwise have to be quietly excused, and an
 * excuse with no register is how a table fills up with patterns matching
 * nothing. Anything added here is a deliberate, reviewable claim that the only
 * producer left is an older peer.
 */
export const RETIRED_PRODUCER_TOKENS: readonly UpdateFailureToken[] = [
  'dirty-working-tree',
  'invalid-git-reference',
  'git-status-failed',
  'git-fetch-failed',
  'git-checkout-failed',
  'git-timed-out',
  'git-cancelled',
]

/**
 * Which token a `detail` sentence carries, or `undefined` when it carries none.
 *
 * `undefined` is a real answer and not a failure: a machine can report free
 * text this table has never seen (a daemon older than a token, an errno from a
 * layer nobody wrapped), and the callers deliberately treat that differently
 * from a recognized token — see {@link classifyUpdateFailureDetail}.
 */
export function matchUpdateFailureToken(
  detail: string | undefined,
): UpdateFailureToken | undefined {
  const normalized = detail?.trim()
  if (!normalized) return undefined
  for (const matcher of UPDATE_FAILURE_MATCHERS) {
    if (matcher.pattern.test(normalized)) return matcher.token
  }
  return undefined
}

/**
 * The code a `detail` sentence resolves to.
 *
 * UNRECOGNIZED FALLS TO `machine-unreachable`, STILL — because for the one
 * remaining case that reaches here unnamed (a machine that said nothing at all
 * before its clock ran out) that is the honest answer, and the alternative is a
 * generic "could not finish" that tells the operator nothing about where to
 * look. What changed in POD-2241 is that it is no longer the answer for eleven
 * sentences that said something precise.
 */
export function classifyUpdateFailureDetail(detail: string | undefined): MachineFailureCode {
  const token = matchUpdateFailureToken(detail)
  return token === undefined ? 'machine-unreachable' : CODE_FOR_UPDATE_FAILURE_TOKEN[token]
}
