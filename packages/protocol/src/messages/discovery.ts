import {
  ConversationDiagnosticWire,
  ConversationSummaryWire,
  DirectoryListingWire,
  GitDiscoveryDiagnosticWire,
  GitRepositoryWire,
} from '@podium/model'
import { z } from 'zod'

// The conversation projection and the per-machine repo/worktree/directory wires
// live in @podium/model (POD-300) — the latter as one named group, because
// everything that is a fact ABOUT a machine inherits that machine's scoping
// (docs/multi-user-readiness.md §3.1.1/§3.1.4). What stays here is the FRAMES:
// discovery scans, directory browsing, and the constrained repo-op vocabulary.

// Shared in both directions: daemon -> server AND server -> client (identical shape).
export const ConversationsChangedMessage = z.object({
  type: z.literal('conversationsChanged'),
  conversations: z.array(ConversationSummaryWire),
  diagnostics: z.array(ConversationDiagnosticWire),
  // Conversation ids pruned this pass. Optional for back-compat: producers that
  // don't yet emit a delta (and older parsers) stay valid without it.
  removed: z.array(z.string()).optional(),
})

// ---- Daemon <-> server: repo/conversation discovery scans ----
export const ScanRequestMessage = z.object({
  type: z.literal('scanRequest'),
  requestId: z.string(),
})
export const ScanReposRequestMessage = z.object({
  type: z.literal('scanReposRequest'),
  requestId: z.string(),
  roots: z.array(z.string()),
  // When false, $HOME is not auto-added as a scan root (so a scan stays rooted at
  // exactly `roots`). When omitted, the daemon keeps its legacy home-inclusive default.
  includeHome: z.boolean().optional(),
  // Bound on how deep the walk descends from each root. 0 only inspects the roots
  // themselves (used to enrich already-registered repos without a filesystem walk).
  maxDepth: z.number().int().nonnegative().optional(),
})
export const ScanResultMessage = z.object({
  type: z.literal('scanResult'),
  requestId: z.string(),
  conversations: z.array(ConversationSummaryWire),
  diagnostics: z.array(ConversationDiagnosticWire),
  // Conversation ids pruned this pass. Optional for back-compat (see above).
  removed: z.array(z.string()).optional(),
})
export const ScanReposResultMessage = z.object({
  type: z.literal('scanReposResult'),
  requestId: z.string(),
  repositories: z.array(GitRepositoryWire),
  diagnostics: z.array(GitDiscoveryDiagnosticWire),
})

// ---- Daemon <-> server: directory browsing (POD-814) [spec:SP-3701] ----
// The repo picker browses the SELECTED machine's disk through its daemon. The
// server host's own filesystem is never the browse target: users pick a machine,
// and in hub-only mode (mode=server) the hub may run no daemon at all.

export const BrowseDirsRequestMessage = z.object({
  type: z.literal('browseDirsRequest'),
  requestId: z.string(),
  /** Absolute path or `~`-relative; omitted browses the daemon's $HOME. */
  path: z.string().optional(),
  /** When false/omitted, dot-directories are filtered out of `entries`. */
  includeHidden: z.boolean().optional(),
})
export type BrowseDirsRequestMessage = z.infer<typeof BrowseDirsRequestMessage>

// Exactly one of `listing` / `error` is set. A failed browse is a RESULT, not a
// dropped request: the daemon reports unreadable/missing paths in `error` so the
// picker shows them instead of hanging until the RPC times out.
export const BrowseDirsResultMessage = z.object({
  type: z.literal('browseDirsResult'),
  requestId: z.string(),
  listing: DirectoryListingWire.optional(),
  error: z.string().optional(),
})
export type BrowseDirsResultMessage = z.infer<typeof BrowseDirsResultMessage>

// Constrained git operations the superagent may run on a dev machine. An
// allowlisted enum (not a shell string) — the daemon maps each op to a fixed
// git invocation.
export const RepoOp = z.enum([
  'clone',
  'status',
  // git-state probes [POD-98] — read-only, safe to run in the background against
  // a checkout agents are actively using. statusProbe differs from 'status' in
  // ONE flag: --no-optional-locks, so a probe can never contend for index.lock
  // with a concurrent `git commit` in the same checkout.
  'statusProbe',
  'revListCount',
  'logHead',
  // Re-derive a task's commits from history by message marker ([POD-98] subject
  // tag or Podium-Issue trailer) — the restart-proof half of attribution.
  'logIssueCommits',
  // Git dock panel [POD-114] — read-only, --no-optional-locks like the probes.
  // logPanel: parseable recent-commit list; diffFile: one file's diff vs HEAD.
  'logPanel',
  'diffFile',
  'log',
  'branches',
  'revParseVerify',
  // OBJECT TRANSFER BETWEEN MACHINES (POD-1405 / POD-1424), the object half of what handoff
  // does with a whole session package. A second machine cannot start work on a
  // branch whose base is on NO shared remote — our integration branches never
  // reach origin — so the commits have to move directly. `bundleCreate` writes a
  // delta bundle into the daemon's own handoff stage; `bundleFetch` reads one
  // that arrived there and fetches it into the target repository. Neither takes a
  // filesystem path from the caller: both derive it from an opaque token, so the
  // server names a TRANSFER, never a location on someone else's disk — a server able
  // to name paths on another machine's disk is a traversal surface no validation closes.
  'bundleCreate',
  'bundleFetch',
  'worktreeAdd',
  // stop→resume [spec:SP-9904]: re-materialize a worktree for an EXISTING branch
  // (no -b/-B). worktreeAdd always creates a new branch; this attaches the
  // preserved branch after free-worktree-keep-branch.
  'worktreeAddExisting',
  'rebase',
  'mergeFfOnly',
  'prCreate',
  // cleanup (issue #71) — remove a merged issue's worktree + branch. worktreeRemove
  // and branchDelete are deliberately non-forcing (`git worktree remove` / `branch -d`,
  // never --force / -D); isMergedInto = `merge-base --is-ancestor` (exit status only).
  'worktreeRemove',
  'branchDelete',
  'isMergedInto',
  // branchReflog: full reflog shas of a branch, oldest last — its creation
  // point. Lets the git-state probe tell "merged" (branch moved, then landed)
  // apart from "fresh branch still at its start point" [POD-156].
  'branchReflog',
  // integrate (issue #70) — rebuild an epic's integration branch from its closed
  // children. worktreeAddReset/checkoutReset use -B (reset-to-startPoint is the
  // POINT: every run rebuilds); rebaseAbort cleanly unwinds a conflicted rebase;
  // branchDeleteForce (-D) is restricted by the daemon to the `integrate-tmp/`
  // temp-ref namespace — child branches are never force-deleted.
  'worktreeAddReset',
  'checkoutReset',
  'checkout',
  'rebaseAbort',
  'branchDeleteForce',
])
export type RepoOp = z.infer<typeof RepoOp>
export const RepoOpRequestMessage = z.object({
  type: z.literal('repoOpRequest'),
  requestId: z.string(),
  op: RepoOp,
  cwd: z.string(),
  // op-specific extras (worktreeAdd: { path, branch }).
  args: z.record(z.string()).optional(),
})
export const RepoOpResultMessage = z.object({
  type: z.literal('repoOpResult'),
  requestId: z.string(),
  ok: z.boolean(),
  output: z.string(),
})
