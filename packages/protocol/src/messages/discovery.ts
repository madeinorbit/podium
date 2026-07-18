import { z } from 'zod'
import { AgentKind, ResumeRef } from './terminal'

// Discovery payloads on the wire — dates are ISO strings (Date is not JSON-safe).
export const ConversationGit = z.object({
  branch: z.string().optional(),
  sha: z.string().optional(),
  originUrl: z.string().optional(),
})
export type ConversationGit = z.infer<typeof ConversationGit>
export const ConversationSummaryWire = z.object({
  id: z.string(),
  /** Absolute transcript path on the owning machine (discovery evidence). The
   *  registry records it on the conversation's segment so later reads locate the
   *  file without deriving from a mutable cwd. Machine-local; optional. */
  path: z.string().optional(),
  /** Podium-generated stable identity (docs/spec/conversation-registry.md). `id`
   *  above is the NATIVE agent session id — evidence, not identity: a resume that
   *  rolls into a new file gets a new `id` but keeps this `podiumId`. Server-
   *  enriched; absent on daemon-originated payloads and for un-indexed rows. */
  podiumId: z.string().optional(),
  agentKind: AgentKind,
  title: z.string().optional(),
  /** Curated display name (user rename via conversations.setMeta). Server-
   *  enriched from the conversations index — never daemon-originated. Display
   *  surfaces let it win over the harness `title`, matching search results. */
  name: z.string().optional(),
  /** Curated work summary (command center / work-LLM). Server-enriched. */
  summary: z.string().optional(),
  projectPath: z.string().optional(),
  parentConversationId: z.string().optional(),
  statusHint: z.string().optional(),
  createdAt: z.string().optional(),
  updatedAt: z.string().optional(),
  messageCount: z.number().int().nonnegative().optional(),
  /** Byte size of `path` at scan time — the transcript mirror's dirty signal:
   *  the server enqueues a pull only when this differs from its mirrored cursor,
   *  so a fully-mirrored fleet costs zero mirror round trips per scan/attach. */
  sizeBytes: z.number().int().nonnegative().optional(),
  git: ConversationGit.optional(),
  resume: ResumeRef.optional(),
  providerId: z.string(),
})
export type ConversationSummaryWire = z.infer<typeof ConversationSummaryWire>

export const ConversationDiagnosticWire = z.object({
  severity: z.enum(['warning', 'error']),
  providerId: z.string().optional(),
  root: z.string().optional(),
  path: z.string().optional(),
  message: z.string(),
})
export type ConversationDiagnosticWire = z.infer<typeof ConversationDiagnosticWire>

export const GitWorktreeWire = z.object({
  path: z.string(),
  branch: z.string().optional(),
  headSha: z.string().optional(),
  locked: z.boolean().optional(),
  prunable: z.boolean().optional(),
})
export type GitWorktreeWire = z.infer<typeof GitWorktreeWire>

export const GitRepositoryWire = z.object({
  path: z.string(),
  kind: z.enum(['repository', 'worktree', 'bare']),
  branch: z.string().optional(),
  headSha: z.string().optional(),
  originUrl: z.string().optional(),
  // Always present on the wire; defaults to [] so producers may omit it safely.
  worktrees: z.array(GitWorktreeWire).default([]),
  /** Server-stamped on scanReposAll(); the daemon never sets this. */
  machineId: z.string().optional(),
  /** Server-stamped stable repo identity (#74); the daemon never sets this. */
  repoId: z.string().optional(),
})
export type GitRepositoryWire = z.infer<typeof GitRepositoryWire>

export const GitDiscoveryDiagnosticWire = z.object({
  severity: z.enum(['warning', 'error']),
  path: z.string(),
  message: z.string(),
})
export type GitDiscoveryDiagnosticWire = z.infer<typeof GitDiscoveryDiagnosticWire>

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
export const DirectoryEntryWire = z.object({
  name: z.string(),
  path: z.string(),
  /** This subfolder is itself a git repo (has a `.git`) — the browser badges it
   *  (POD-855) [spec:SP-5eb6]. Cheap: one stat per entry on the daemon. Optional
   *  for back-compat; an older daemon omits it and the browser shows no badge. */
  isRepo: z.boolean().optional(),
})
export type DirectoryEntryWire = z.infer<typeof DirectoryEntryWire>

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
  'status',
  'log',
  'branches',
  'revParseVerify',
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
