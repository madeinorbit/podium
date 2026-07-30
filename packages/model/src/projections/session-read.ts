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
export interface SessionStatusResult {
  /** SCHEMA: SessionIdentity (`sessionId`, `agentKind`). Unbranded here because
   *  it crosses a tRPC boundary as JSON; branding is POD-365/POD-361 territory. */
  sessionId: string
  agentKind: string
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
  account: string | null
  /** SCHEMA: AgentRuntimeState.error */
  error: { class: string; retryable: boolean } | null
  /** SCHEMA: SessionRef.refDraft */
  draft: boolean
  /** SCHEMA: AgentRuntimeState.nativeSubagentCount */
  nativeSubagentCount: number
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
