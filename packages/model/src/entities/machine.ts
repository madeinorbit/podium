/**
 * # The per-machine fact group
 *
 * ONE named, coherent group holding every schema that is a FACT ABOUT A
 * MACHINE, relocated verbatim at POD-300 from three files in
 * `@podium/protocol` — `messages/host.ts` (machine, host metrics, memory
 * breakdown, usage, quota), `messages/inventory.ts` (harness + tool inventory)
 * and `messages/discovery.ts` (repos, worktrees, directory browsing). Field
 * names, order, optionality and defaults are unchanged; the move is
 * byte-identical on the wire, pinned by
 * `packages/protocol/src/messages/wire-golden.json`.
 *
 * ## Why they are one group
 *
 * Per `docs/multi-user-readiness.md` §3.1.1 and §3.1.4 (human decisions,
 * 2026-07-29), **machines are OWNED COMPUTE, not tenant-visible
 * infrastructure**, and:
 *
 * > Everything that is a fact *about a machine* inherits that machine's scoping
 * > rather than carrying its own.
 *
 * **So every schema in this file inherits its machine's scoping.** None of them
 * carries, or should later carry, its own owner or visibility. They were spread
 * across five files; grouping them means POD-1079 (§4.11, machine ownership and
 * grants) attaches an owner and a grant list at ONE place instead of chasing
 * schemas across the wire surface.
 *
 * The one deliberate exclusion: `SessionMeta.machineId` / `machineName` stay on
 * the session (`entities/session.ts`). They are a *reference to* a machine, not
 * a fact about one — and §3.1.4 M1 puts "your session ran there" attribution
 * inside the `see` verb, so they follow the session's scoping, not the
 * machine's.
 *
 * ## The see / use partition (a NOTE, not a schema change, not a policy)
 *
 * §3.1.4 M1 splits machine access into three verbs — **see** (it exists;
 * health/liveness; "your session ran there" attribution), **use** (spawn,
 * reattach, attach a PTY, harness exec, read/write files, take a worktree) and
 * **manage** (rename, unpair, rotate token). A principal with `see` but not
 * `use` may know a machine exists without learning what is checked out on it,
 * so the wire projection keeps those two slices separable.
 *
 * `MachineWire.use` carries the principal's decision. Redacting the USE-only
 * detail slice remains a projection concern. The partition below ensures
 * the projection split is later a partition of an already-annotated set rather
 * than a fresh field-by-field audit. Every schema below carries a
 * `SEE` / `USE` marker in its doc comment.
 *
 * | Slice | Marker | Schemas |
 * |---|---|---|
 * | existence / health / attribution | `SEE` | {@link MachineWire} minus `inventory`, {@link HostMetricsWire}, {@link HostMemoryWire} |
 * | use-gated detail | `USE` | {@link Inventory} (+ {@link AgentInventory}, {@link ToolInventory}), {@link AgentMemoryWire}, {@link ProjectMemoryWire}, {@link UsageBucketWire}, {@link QuotaWindowWire}, {@link AgentQuotaWire}, {@link MachineQuotaWire}, {@link GitRepositoryWire}, {@link GitWorktreeWire}, {@link GitDiscoveryDiagnosticWire}, {@link DirectoryEntryWire}, {@link DirectoryListingWire} |
 *
 * **This is a partition, NOT a policy.** §3.1.2 deliberately leaves open which
 * existence facts leak at all — counts, machine session lists, "this worktree
 * is in use", lock holders — and POD-300 settles none of them. Three fields are
 * flagged inline as sitting exactly on that open boundary rather than resolved:
 * `HostMetricsWire.idleCapUnmet` (a session count),
 * `AgentMemoryWire.sessionId` (a machine session list) and
 * `GitWorktreeWire.locked` (whether a worktree is in use). Whoever draws the
 * projection decides them; this file only makes sure they are not discovered
 * late.
 *
 * ## What was NOT added
 *
 * No `owner`, `visibility`, `grant` or `instance_id` field. Ownership and
 * grants are POD-1075's model types and POD-1071's normative matrix columns,
 * and `use` is an evaluated decision rather than any of those policy inputs.
 * Every schema below is a flat aggregate with no positional
 * encoding, so an `owner` field is purely additive later — the golden fixtures
 * pin this issue's deliberate additive `use` change.
 * And multi-user is NOT multi-tenancy (ADR 1 D5): nothing here carries an
 * instance partition.
 *
 * **Amended by POD-1495, and the distinction is the whole of it.** `MachineWire`
 * now carries `owned` — a VIEWER-RELATIVE boolean, "are you this machine's
 * owner". That is not the `owner` field refused above: no user id crosses the
 * wire, and "someone else's" and "nobody's" are one indistinguishable `false`,
 * so the ownership GRAPH this paragraph protects is still server-side. What it
 * buys is a settings panel that can withhold an owner-only control instead of
 * offering it to everyone and letting the server refuse.
 *
 * ## Embeds found (for the de-nesting work)
 *
 * - `MachineWire.inventory` — issue-owned detail of the machine, not an
 *   independent entity, and it is exactly the `USE` slice, so keeping it inline
 *   is also what makes the projection split a clean field drop.
 * - `GitRepositoryWire.worktrees[]` — a worktree is a per-(branch, machine)
 *   materialization [spec:SP-4ef9], owned by its repo record.
 * - `MachineQuotaWire.agents[]` and `AgentQuotaWire.windows[]` — value objects.
 *
 * None is an entity-in-entity embed of the `IssueWire.sessions` kind (see
 * `entities/issue.ts`), and none is hardened by this move.
 */

import { z } from 'zod'
import { MachineIdField, RepoIdField, SessionIdField } from '../ids'
import { AgentKind, HarnessAgent } from './agent'

// ---------------------------------------------------------------------------
// Harness + tool inventory (was messages/inventory.ts)
// ---------------------------------------------------------------------------
// Machine inventory (#222): what a daemon's host can actually run. Built by the
// daemon (packages/harness buildInventory) and pushed AFTER the handshake
// authenticates — never inside pair/hello, which must stay fast and pre-auth.

/** `USE` — one agent CLI's install + login status on the daemon's machine.
 *  Use-gated: `login.account` names a person, and the install set describes what
 *  the owner's hardware can run. */
export const AgentInventory = z.object({
  kind: HarnessAgent,
  installed: z.boolean(),
  /** Parsed from `<cli> --version`; absent when not installed / parse failed. */
  version: z.string().optional(),
  /** Resolved binary path when installed (may be a bare PATH name). */
  path: z.string().optional(),
  login: z.object({
    /** 'unknown' for kinds with no credential detector (opencode, cursor). */
    state: z.enum(['in', 'out', 'unknown']),
    /** Email / account label when known (claude, codex, grok). */
    account: z.string().optional(),
    identity: z
      .object({
        fingerprint: z.string().min(1),
        email: z.string().optional(),
        providerAccountId: z.string().optional(),
      })
      .optional(),
    freshness: z.number().optional(),
  }),
})
export type AgentInventory = z.infer<typeof AgentInventory>

/** `USE` — a non-harness CLI the host may carry. `gh` (#214) is the first
 *  consumer: its credential-propagation form needs to know a machine has gh on
 *  PATH. */
export const ToolInventory = z.object({
  name: z.string(),
  installed: z.boolean(),
  /** Parsed from `<name> --version`; absent when not installed / parse failed. */
  version: z.string().optional(),
  /** Resolved binary path when installed (may be a bare PATH name). */
  path: z.string().optional(),
})
export type ToolInventory = z.infer<typeof ToolInventory>

/** `USE` — the whole inventory is use-gated detail: it is the answer to "what
 *  can I run on your hardware, and as whom", which §3.1.4 M2 calls a
 *  code-execution boundary rather than a privacy one. */
export const Inventory = z.object({
  os: z.enum(['linux', 'darwin']),
  arch: z.enum(['x64', 'arm64']),
  /** Absent until #221 ships `podium --version`. */
  podiumVersion: z.string().optional(),
  /** All 5 HarnessAgent kinds, present or not. */
  agents: z.array(AgentInventory),
  /** Non-harness CLIs (currently just `gh` for #214). Defaulted so an
   *  inventory_json blob persisted before this field parses back cleanly. */
  tools: z.array(ToolInventory).default([]),
})
export type Inventory = z.infer<typeof Inventory>

// ---------------------------------------------------------------------------
// Machine identity + health (was messages/host.ts)
// ---------------------------------------------------------------------------

// Memory state of a daemon host. "Available" is the kernel's estimate of memory
// applications can still allocate without swapping (Linux MemAvailable) — used is
// total − available, NOT total − free, so page cache doesn't read as pressure.
// Swap travels alongside but is never folded into the headline number.
const byteCount = z.number().int().nonnegative()

/** `SEE` — pure health/liveness. */
export const HostMemoryWire = z.object({
  totalBytes: byteCount,
  availableBytes: byteCount,
  swapTotalBytes: byteCount,
  swapFreeBytes: byteCount,
})
export type HostMemoryWire = z.infer<typeof HostMemoryWire>

/** `SEE` — health/liveness sample, plus the machine identity it is about. */
export const HostMetricsWire = z.object({
  hostname: z.string(),
  machineId: MachineIdField.optional(), // server-filled before broadcast
  name: z.string().optional(), // server-filled before broadcast
  sampledAt: z.string(), // ISO 8601
  memory: HostMemoryWire,
  /** Protected/ineligible idle-live sessions above the convergence target.
   *  ON THE §3.1.2 OPEN BOUNDARY: this is a session COUNT, and whether counts
   *  are an existence leak is deliberately undecided. Marked `SEE` because it is
   *  health-shaped; whoever draws the projection may move it to `USE`. */
  idleCapUnmet: z.number().int().nonnegative().optional(),
})
export type HostMetricsWire = z.infer<typeof HostMetricsWire>

/** `SEE` for everything except `inventory`, which is `USE`. The machine's
 *  existence, name and liveness are the whole content of §3.1.4 M1's `see`
 *  verb; `inventory` is what a principal with `see` but not `use` must not
 *  learn, and it is a single field so the projection split is a field drop. */
/** One principal's live USE verdict for a visible machine. */
export const MachineUseDecision = z.enum(['granted', 'denied'])
export type MachineUseDecision = z.infer<typeof MachineUseDecision>

export const MachineWire = z.object({
  /** THE machine id itself — and the site that made ADR 1 Amendment 2 D16.2 an
   *  ORDERING constraint rather than a preference: while the server upserted this
   *  row with the constant `'local'`, branding here would have minted a well-typed
   *  `MachineId` for a sentinel at its source. POD-318 retired the constant (the row
   *  carries the id minted in `<stateDir>/machine.id`) and `MachineId` refuses both
   *  literals, so the brand lands. */
  id: MachineIdField,
  name: z.string(),
  hostname: z.string(),
  online: z.boolean(),
  lastSeenAt: z.string(), // ISO 8601
  /** The authenticated viewer's live `USE` decision. Absent only on unscoped internal lists. */
  use: MachineUseDecision.optional(),
  /**
   * `SEE` — VIEWER-RELATIVE, and deliberately not an owner id (POD-1495).
   *
   * `true` means *you* are this machine's current owner. It is the one
   * ownership fact a client needs in order not to OFFER an act only the owner
   * may perform — `machines.transferOwnership` is owner-only (POD-1480), and a
   * control that renders for a manage grantee is a control that fails.
   *
   * The file header's "no owner field" still holds in the sense that matters:
   * this carries no owner IDENTITY. `false` collapses "someone else owns it"
   * and "nobody owns it" into one answer, because both refuse the same act and
   * splitting them would tell a see-only principal who the owner is —
   * `ownershipRows`' own comment: a client "does not need to be told who owns
   * it in order to be refused". Adoption of an unowned machine is a different
   * act with different authority (POD-1494) and is not derivable from here.
   *
   * OMITTING IT MEANS NOT EVALUATED, the same closed reading as `use` — never
   * "yes".
   */
  owned: z.boolean().optional(),
  /** Whether this machine was paired as a Podium-managed host. */ podiumManaged: z
    .boolean()
    .optional(),
  /** `USE` — see {@link Inventory}. */
  inventory: Inventory.optional(),
  /** Peer-asserted build label; absent/null until the daemon reports one. */
  appVersion: z.string().nullable().optional(),
  /** Peer-asserted protocol schema digest; informational only. */
  wireSchemaDigest: z.string().nullable().optional(),
  /** Whether the daemon runs an installed bundle or a source checkout. */
  installKind: z.string().nullable().optional(),
  /** Delivery methods the daemon offered in its last authenticated hello. */
  deliveryCaps: z.array(z.string()).optional(),
  /** When the server last accepted the build report. */
  buildReportedAt: z.string().nullable().optional(),
  /** Derived relative state; never persisted. */
  versionState: z.enum(['unreported', 'current', 'behind', 'ahead']).optional(),
})
export type MachineWire = z.infer<typeof MachineWire>

// ---------------------------------------------------------------------------
// Memory attribution (was messages/host.ts)
// ---------------------------------------------------------------------------
// Who owns the used memory. Agents are attributed by process tree (the session's
// PTY/durable-host subtree); projects by working directory under a controlled root.
// Sizes are PSS where readable (shared pages divided fairly), RSS otherwise.

/** `USE` — ON THE §3.1.2 OPEN BOUNDARY: this is literally a machine session
 *  list, one of the named-but-undecided existence-leak cases. Marked `USE`
 *  because it names sessions running on someone else's hardware. */
export const AgentMemoryWire = z.object({
  sessionId: SessionIdField,
  bytes: z.number().int().nonnegative(),
  processCount: z.number().int().nonnegative(),
})
export type AgentMemoryWire = z.infer<typeof AgentMemoryWire>

/** `USE` — `root` and `topProcesses[].name` describe what is checked out and
 *  running on the owner's machine. */
export const ProjectMemoryWire = z.object({
  root: z.string(),
  bytes: z.number().int().nonnegative(),
  processCount: z.number().int().nonnegative(),
  topProcesses: z.array(z.object({ name: z.string(), bytes: z.number().int().nonnegative() })),
})
export type ProjectMemoryWire = z.infer<typeof ProjectMemoryWire>

// ---------------------------------------------------------------------------
// Token usage + plan quota (was messages/host.ts)
// ---------------------------------------------------------------------------

/** `USE` — token-usage harvest from harness transcripts (ccusage-style, in-house
 *  so it feeds the same wire). Hourly buckets keep the payload small while
 *  supporting 5h/weekly windows and per-day analytics. */
export const UsageBucketWire = z.object({
  /** Bucket start, ISO 8601, truncated to the hour. */
  hour: z.string(),
  model: z.string(),
  inputTokens: z.number().int().nonnegative(),
  outputTokens: z.number().int().nonnegative(),
  cacheReadTokens: z.number().int().nonnegative(),
  cacheCreationTokens: z.number().int().nonnegative(),
  messages: z.number().int().nonnegative(),
})
export type UsageBucketWire = z.infer<typeof UsageBucketWire>

// ── Agent plan-quota (rate-limit windows). Distinct from UsageBucketWire, which
// is transcript-harvested token-cost analytics. Quota is the share of each rolling
// plan window consumed + when it resets, read live from each agent's own usage
// endpoint on the daemon host. Providers may add/remove scoped windows over time.

/** `USE` — the owner's plan capacity. */
export const QuotaWindowWire = z.object({
  key: z.string().min(1),
  label: z.string(),
  usedPercent: z.number(), // 0..100
  resetsAt: z.string(), // ISO 8601 ('' when unknown)
  // 0 when a provider reports a new limit without enough metadata to infer its
  // rolling duration. The UI still shows it, but omits the pace marker.
  windowMinutes: z.number().int().nonnegative(),
  // Set when the provider scopes this limit to one model (Claude's
  // `weekly_scoped` + `scope.model`). Such a window is extra capacity for that
  // model alone: spending it drops the model, not the harness, which falls back
  // onto the unscoped pool. Absent means the window gates all work. [spec:SP-0610]
  scopeModel: z.string().optional(),
})
export type QuotaWindowWire = z.infer<typeof QuotaWindowWire>

/** `USE` — `account.email` / `account.plan` name the machine owner's
 *  subscription. §3.1.4 M2's unresolved billing question ("server-injected
 *  material IS separable and should plausibly bill the delegating human") lands
 *  on this schema; it is a per-feature call, not settled here. */
export const AgentQuotaWire = z.object({
  agent: AgentKind,
  status: z.enum(['ok', 'unauthenticated', 'expired', 'error']),
  account: z.object({ email: z.string().optional(), plan: z.string().optional() }).optional(),
  windows: z.array(QuotaWindowWire),
  error: z.string().optional(),
  fetchedAt: z.string(), // ISO 8601
})
export type AgentQuotaWire = z.infer<typeof AgentQuotaWire>

/** `USE` — one dev machine's quota, tagged with which machine it came from. The
 *  overlay groups by machine because each machine runs its agents under its own
 *  account. The daemon↔server wire (AgentQuotaRequest/Result) stays
 *  single-machine; the server fans out one request per online machine and tags
 *  each reply. */
export const MachineQuotaWire = z.object({
  machineId: MachineIdField,
  machineName: z.string(),
  hostname: z.string(),
  agents: z.array(AgentQuotaWire),
})
export type MachineQuotaWire = z.infer<typeof MachineQuotaWire>

// ---------------------------------------------------------------------------
// Repos, worktrees and directory browsing (was messages/discovery.ts)
// ---------------------------------------------------------------------------
// These are per-machine facts in the fullest sense: §3.1.4 M1 gives "what is
// checked out on it" as the canonical example of what `see` must NOT reveal.

/** `USE` — [spec:SP-4ef9] a worktree is a per-(branch, machine) materialization. */
export const GitWorktreeWire = z.object({
  path: z.string(),
  branch: z.string().optional(),
  headSha: z.string().optional(),
  /** ON THE §3.1.2 OPEN BOUNDARY: "whether a worktree is in use" is one of the
   *  named-but-undecided existence questions. */
  locked: z.boolean().optional(),
  prunable: z.boolean().optional(),
})
export type GitWorktreeWire = z.infer<typeof GitWorktreeWire>

/** `USE` — the machine's repos and prefixes. */
export const GitRepositoryWire = z.object({
  path: z.string(),
  kind: z.enum(['repository', 'worktree', 'bare']),
  branch: z.string().optional(),
  headSha: z.string().optional(),
  originUrl: z.string().optional(),
  // Always present on the wire; defaults to [] so producers may omit it safely.
  worktrees: z.array(GitWorktreeWire).default([]),
  /** Server-stamped on scanReposAll(); the daemon never sets this. It used to be
   *  carved out of the brand because `repos.machine_id` DEFAULTED to `'__local__'`
   *  and the database manufactured that sentinel for any insert omitting the column
   *  — POD-318 dropped the default and every writer names a real machine. */
  machineId: MachineIdField.optional(),
  /** Server-stamped stable repo identity (#74); the daemon never sets this. */
  repoId: RepoIdField.optional(),
})
export type GitRepositoryWire = z.infer<typeof GitRepositoryWire>

/** `USE` — carries filesystem paths from the scanned machine. */
export const GitDiscoveryDiagnosticWire = z.object({
  severity: z.enum(['warning', 'error']),
  path: z.string(),
  message: z.string(),
})
export type GitDiscoveryDiagnosticWire = z.infer<typeof GitDiscoveryDiagnosticWire>

// Directory browsing (POD-814) [spec:SP-3701]. The repo picker browses the
// SELECTED machine's disk through its daemon. The server host's own filesystem is
// never the browse target: users pick a machine, and in hub-only mode
// (mode=server) the hub may run no daemon at all.

/** `USE` — a listing of the owner's disk; §3.1.4 M1 puts "read/write files"
 *  squarely in the `use` verb. */
export const DirectoryEntryWire = z.object({
  name: z.string(),
  path: z.string(),
  /** This subfolder is itself a git repo (has a `.git`) — the browser badges it
   *  (POD-855) [spec:SP-5eb6]. Cheap: one stat per entry on the daemon. Optional
   *  for back-compat; an older daemon omits it and the browser shows no badge. */
  isRepo: z.boolean().optional(),
})
export type DirectoryEntryWire = z.infer<typeof DirectoryEntryWire>

/** `USE` — see {@link DirectoryEntryWire}. */
export const DirectoryListingWire = z.object({
  /** The resolved directory that was listed (realpath of the requested path). */
  path: z.string(),
  /** The browsed machine's $HOME — the picker's "Home" button target. */
  homePath: z.string(),
  /** null at the filesystem root, where there is nowhere further up. */
  parentPath: z.string().nullable(),
  // Always present on the wire; defaults to [] so producers may omit it safely.
  entries: z.array(DirectoryEntryWire).default([]),
  /** The browsed folder ITSELF is a git repo — the picker only lets you add a repo
   *  (POD-855) [spec:SP-5eb6], so this gates the "Add repo" button. Optional for
   *  back-compat with pre-POD-855 daemons. */
  isRepo: z.boolean().optional(),
  /** The browsed repo's origin URL when it has one — the picker names the add
   *  target from it (repoNameFromOrigin), falling back to the folder name. */
  originUrl: z.string().optional(),
})
export type DirectoryListingWire = z.infer<typeof DirectoryListingWire>
