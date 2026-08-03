/**
 * Session READ projections (ADR 4 R4) — the tier-1/2/3 session read models, in
 * the one place both the server that produces them and the CLI that renders
 * them can name (POD-366).
 *
 * WHY THESE MOVED HERE. `docs/rearch-field-schema-inventory.md` §2.1 counts
 * `SessionStatusResult` (#21, `modules/sessions/read-toolkit.ts`) as a
 * legitimate R4 role and `StatusWire` (#22, `apps/cli/src/session-cli.ts`) as a
 * **drifted duplicate** — "key-for-key hand copy; its own comment names the
 * source". The copies existed for a structural reason, not carelessness:
 * `apps/cli` cannot import from `apps/server` without breaking the declared-deps
 * boundary gate, so there was nowhere shared to put the shape. `@podium/model`
 * is L0 and `apps/cli` already declares it, so that reason is gone.
 *
 * §2.1 counts only `StatusWire`, but the same file carried `RecapWire` (a
 * key-for-key copy of {@link SessionRecapResult}) and `ReadWire` (a structural
 * subset of {@link SessionReadResult}). All three are retired together: fixing
 * one and leaving its siblings in place would leave the audit at POD-368 to
 * rediscover exactly this class in exactly this file.
 *
 * NOT THE CANONICAL AGGREGATE. These are read models over a session, deliberately
 * distinct from storage (R3), live state (R2) and the `SessionMeta` feed
 * projection (R4) — ADR 4 D1 keeps those apart, and if a read model and a
 * storage row ever become the same type the composition has gone too far.
 *
 * STILL HAND-WRITTEN, ON PURPOSE. Every field below is spelled out rather than
 * `Pick`ed, because POD-365 has not landed the shared session field schemas yet
 * (`SessionIdentity`, `SessionLifecycle`, `AgentRuntimeState`, … — inventory
 * §6.2). That is the remaining half of this issue, and consolidating first means
 * the re-derivation edits ONE definition instead of two. The keys that will
 * compose rather than restate are marked `SCHEMA:` below.
 */

/**
 * Tier-1 status read model: everything `podium session status` prints.
 *
 * Widened intentionally beyond what any single caller reads — the CLI's retired
 * `StatusWire` omitted nothing, and narrowing here would just re-create the
 * subset drift this file deletes.
 */
/**
 * One Podium session spawned (transitively) by the session being read — the
 * `subagents:` block of `podium session status` (ab75ab1e).
 *
 * A read model over another session, not an embed of it: only the keys the
 * status renderer prints, resolved at read time by walking `spawnedBy`.
 */
export interface SessionStatusSubagent {
  sessionId: string
  /** Human-facing session ref when known (e.g. POD-966-A). */
  displayRef?: string
  /** The session this one was spawned by — the walk's edge, kept so a reader can
   *  rebuild the tree from a flat list. */
  parentSessionId: string
  harness: string
  model: string | null
  effort: string | null
  contextUsagePercent: number | null
  status: string
  phase: string
}

export interface SessionStatusResult {
  /** SCHEMA: SessionIdentity (`sessionId`, `agentKind`). Unbranded here because
   *  it crosses a tRPC boundary as JSON; branding is POD-365/POD-361 territory. */
  sessionId: string
  agentKind: string
  /** The harness actually running the session. Same value as `agentKind` today;
   *  carried separately because the status renderer labels it "harness" and
   *  {@link SessionStatusSubagent} names only that half (ab75ab1e). */
  harness: string
  /** SCHEMA: SessionLifecycle.status */
  status: string
  /** SCHEMA: AgentRuntimeState.phase, flattened for display. */
  phase: string
  /** SCHEMA: SessionPlacement.machineId — a reference TO a machine, resolved to
   *  its display name. A machine fact embedded in a session shape INHERITS that
   *  machine's scoping (ADR 9 D3 rule 3, inventory §2); it is not classified
   *  independently here. */
  machine: string | null
  /** SCHEMA: SessionLaunchConfig (`model`, `effort`, `accountId`). */
  model: string | null
  effort: string | null
  /** SCHEMA: AgentRuntimeState.contextUsagePercent. `null` when the harness does
   *  not expose both used tokens and window capacity (ab75ab1e). */
  contextUsagePercent: number | null
  account: string | null
  /** SCHEMA: AgentRuntimeState.error */
  error: { class: string; retryable: boolean } | null
  /** SCHEMA: SessionRef.refDraft */
  draft: boolean
  /** SCHEMA: AgentRuntimeState.nativeSubagentCount */
  nativeSubagentCount: number
  /** SCHEMA: AgentRuntimeState.nativeSubagents — the harness's own in-process
   *  subagents, which have no session of their own. */
  nativeSubagents: { id: string; type?: string }[]
  /** Podium sessions spawned by this one, transitively (ab75ab1e). Distinct from
   *  `nativeSubagents`: each of these IS a session and can be read on its own. */
  subagents: SessionStatusSubagent[]
  /** The bound issue, denormalized for one-shot display. Not an entity embed:
   *  ADR 4 D7.1 forbids entity-in-entity on the FEED, and this is a read model
   *  assembled per request, not a replicated row. */
  issue: { seq: number; stage: string; title: string; todos: string[] } | null
  /** Last ≤5 one-line commits on the session's branch (`git -C <cwd> log`). */
  commits: string[]
  /** Working-tree touched files (`git status --porcelain`), capped. */
  files: string[]
  /** Messages delivered to this session still awaiting its ack. */
  unackedMessages: number
}

/**
 * The compact session line an issue tree / `issue show` carries (inventory §2.1
 * #19, ADR 4 R4) — moved here from `apps/server/src/modules/issues/service/types.ts`
 * so `@podium/issue-client` can name it instead of hand-copying it as
 * `ShowSession` (§2.1 #20). Same structural reason as the read models above:
 * `packages/issue-client` cannot import `apps/server`, and it already declares
 * `@podium/model`.
 *
 * DELIBERATELY FLATTENED, and it is the flattening that made the copy drift.
 * The producer (`modules/issues/service/reads.ts`) collapses `name`/`title` into
 * one `label` and `agentState.phase` into one `phase` before it ever reaches the
 * wire. The retired `ShowSession` also declared `name`, `title` and a nested
 * `agentState: { phase?: string }` — keys the current server cannot send. They
 * survive in the client as documented version-skew tolerance, NOT as part of
 * this shape.
 *
 * SCHEMA: `sessionId`/`agentKind` are SessionIdentity, `status` is
 * SessionLifecycle, `phase` is AgentRuntimeState, `label` is SessionNaming and
 * `displayRef` is SessionDerived (derived from SessionRef + repo prefix, never
 * stored — inventory D-5). Those become `Pick`s once POD-365 lands §6.2.
 */
export interface IssueTreeSession {
  sessionId: string
  /** Human-facing session ref when known (e.g. POD-966-A). */
  displayRef?: string
  /** Curated name, else live terminal title. */
  label?: string
  agentKind: string
  model?: string
  /**
   * Reasoning effort, and how full the agent's context is (0-100).
   *
   * Carried forward from main's POD-1262 during the POD-1439 reconciliation. The
   * CLI renders both on every session line, so before this they were declared
   * locally in two places (issue-client and the session CLI) against a model
   * that did not name them — which is the duplicate-vocabulary problem this
   * epic exists to remove. Defined here, once, because that is where a field's
   * meaning lives.
   */
  effort?: string
  contextUsagePercent?: number
  /** PTY/process status: starting | live | reconnecting | hibernated | exited. */
  status: string
  /** Agent phase when known (working | idle | needs_user | …). */
  phase?: string
  /** True when this session is the issue's designated coordinator. */
  coordinator?: boolean
}

/**
 * Drop keys whose value is `undefined`, so an optional field is ABSENT rather
 * than present-and-undefined.
 *
 * This exists to let a mapper build one fully-spelled object literal (which
 * TypeScript excess-property-checks) instead of assembling it from conditional
 * spreads (which it does not — see {@link toIssueTreeSession}). Key presence is
 * preserved exactly, which is what the `...(x ? { x } : {})` idiom was buying.
 */
function withoutUndefined<T extends object>(o: T): T {
  const out = {} as Record<string, unknown>
  for (const [k, v] of Object.entries(o)) if (v !== undefined) out[k] = v
  return out as T
}

/**
 * The ONE construction site for {@link IssueTreeSession} (inventory §6.5 rule 2:
 * one documented mapper per hop; rule 1: no inline object literal building a
 * session shape in a return position).
 *
 * WHY IT IS SHAPED LIKE THIS, and not as the conditional-spread literal it
 * replaced. POD-366 mutation-tested the claim that the model definition
 * constrains its producers, and the original producer
 * (`...(label ? { label } : {})` inside a `const sessions: IssueTreeSession[]`)
 * failed that test: TypeScript applies neither excess-property checking nor
 * missing-property checking through a spread, so the annotation policed nothing.
 *
 * What this shape actually buys, stated exactly, because each clause was
 * mutation-verified rather than assumed:
 *  - A field the model REQUIRES but the mapper stops supplying is a compile
 *    error (`TS2741`). Verified: renaming `status` on the definition reds this
 *    file.
 *  - A key the mapper writes that the model does NOT declare is a compile error,
 *    via the `satisfies` clause. Verified: adding a `bogusExcessKey` reds this
 *    file. Without `satisfies` it did not — the generic on
 *    {@link withoutUndefined} widens the literal and excess keys survive
 *    assignability.
 *  - An OPTIONAL field renamed to another optional field is NOT caught here, and
 *    cannot be: neither spelling is required, so nothing is missing. It is caught
 *    at the READERS instead (`packages/issue-client` reds on `s.label`), which is
 *    where an unused optional field actually matters.
 *
 * {@link withoutUndefined} then keeps the emitted key set identical to what the
 * conditional spreads produced, so this is a compile-time change only.
 *
 * The two flattenings the shape depends on live here and nowhere else: `label`
 * is the curated name falling back to a live title that is not just the harness
 * name, and `phase` comes off the live agent state.
 */
export function toIssueTreeSession(src: {
  sessionId: string
  displayRef?: string | undefined
  name?: string | undefined
  title?: string | undefined
  agentKind: string
  model?: string | undefined
  effort?: string | undefined
  contextUsagePercent?: number | undefined
  status: string
  agentState?: { phase?: string | undefined } | undefined
  coordinator?: boolean | undefined
}): IssueTreeSession {
  // `??` not `||`, matching the retired producer exactly: an empty `name` selects
  // the empty string rather than falling through to `title`, and the key is then
  // dropped below. Swapping in `||` here would start emitting a title-derived
  // label where the old code emitted nothing.
  const label = src.name ?? (src.title && src.title !== src.agentKind ? src.title : undefined)
  // `|| undefined` on every optional key, so FALSY (not merely undefined) values
  // are dropped. That is what `...(x ? { x } : {})` did, and an empty string is
  // the case where the two differ — reproducing it keeps the emitted key set
  // byte-identical. Pinned by session-read.test.ts.
  //
  // `satisfies` is load-bearing, not decoration: it is what makes an excess key
  // a compile error. Dropping it silently re-opens the drift (see above).
  const projected = {
    sessionId: src.sessionId,
    displayRef: src.displayRef || undefined,
    label: label || undefined,
    agentKind: src.agentKind,
    model: src.model || undefined,
    effort: src.effort || undefined,
    // `!== undefined`, not `||`: 0% is a real reading and the falsy-drop idiom
    // used for the string fields would erase it (matches main's producer).
    contextUsagePercent: src.contextUsagePercent,
    status: src.status,
    phase: src.agentState?.phase || undefined,
    coordinator: src.coordinator || undefined,
  } satisfies IssueTreeSession
  return withoutUndefined(projected)
}

/** Tier-2 transcript read model: a page of transcript items plus its cursor. */
export interface SessionReadResult {
  sessionId: string
  items: {
    role: string
    text: string
    toolName?: string
    toolInput?: string
    ts?: string
  }[]
  /** Cursor of the OLDEST item returned — pass as `--cursor` to page further back. */
  cursor: string | null
  hasMore: boolean
  truncated: boolean
}

/** Tier-3 recap read model: the deterministic recap and its watermark. */
export interface SessionRecapResult {
  sessionId: string
  /** Deterministic Hermes-style recap of the window since the watermark. */
  recap: string
  /** Pass back as `--since` (also persisted per (reader, target)) — the next
   *  call summarizes only what happened after this cursor. */
  watermark: string | null
  /** Items the recap covered; 0 = nothing new since the watermark. */
  newItems: number
  /** True when this call summarized a delta (a watermark was in effect). */
  delta: boolean
}
