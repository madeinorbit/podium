import {
  AgentKind,
  AgentMemoryWire,
  AgentQuotaWire,
  HostDiskWire,
  HostMemoryWire,
  HostMetricsWire,
  MachineIdField,
  MachineWire,
  ProjectMemoryWire,
  SessionIdField,
  UsageBucketWire,
} from '@podium/model'
import { z } from 'zod'

// MachineWire, host metrics + memory, usage buckets and agent/machine quota all
// live in @podium/model (POD-300) as one named per-machine fact group — see
// packages/model/src/entities/machine.ts for why they are grouped and for the
// see/use partition recorded on each field. What stays here is the FRAMES.

export const MachinesChangedMessage = z.object({
  type: z.literal('machinesChanged'),
  machines: z.array(MachineWire),
})

// A git worktree was created for repoPath (POD-665) — daemon-created, so
// connected clients otherwise never learn about it until reload. Carries
// which repo changed (not the new worktree/repo payload itself: scanReposAll()
// returns [] with a diagnostic when a fan-out degrades, and pushing that
// unattended could clobber a good client repo list) so a future client could
// re-fetch selectively; today the client just re-fetches everything via the
// same discovery.refreshRepos path it already uses at boot. Unlike
// machinesChanged, this is a one-shot invalidation — NOT re-served on attach;
// the client's boot-time repo fetch is the catch-up path for anyone who missed
// it. [spec:SP-4ef9] a worktree is a per-(branch,machine) materialization.
export const WorktreesChangedMessage = z.object({
  type: z.literal('worktreesChanged'),
  repoPath: z.string(),
  machineId: MachineIdField.optional(),
})

// Latest sample per daemon host. An array (not a single host) so the wire shape
// already accommodates multiple machines each running a daemon.
export const HostMetricsChangedMessage = z.object({
  type: z.literal('hostMetricsChanged'),
  hosts: z.array(HostMetricsWire),
})
// A session crossed into a state that wants the human (question, permission,
// error, plan approval). Clients surface it as a web notification when hidden.
export const AttentionEventMessage = z.object({
  type: z.literal('attentionEvent'),
  sessionId: SessionIdField,
  title: z.string(),
  body: z.string(),
})

// Periodic host health sample (currently every ~5 s). hostname keys the server's
// latest-per-host map so several machines' daemons can report side by side.
export const HostMetricsMessage = z.object({
  type: z.literal('hostMetrics'),
  ...HostMetricsWire.shape,
})

/**
 * Server→daemon: give back the client terminals nobody is watching (POD-2059).
 *
 * THE THRESHOLD IS THE SERVER'S, THE CHOICE IS THE MACHINE'S. Host pressure is
 * decided where the setting lives (`hosts/service.ts` reads the hibernation
 * config), and this frame is what spec §5's "attachments are reclaimed FIRST"
 * looks like on the wire: it is sent INSTEAD OF parking a session, so a
 * convenience terminal cannot outlive an agent it pushed into hibernation. Which
 * attachments to close is the daemon's — it holds the viewer state and the ages,
 * and a watched terminal is never a cheaper trade than an idle agent.
 *
 * NO SESSION ID: it is a machine-wide sweep of a machine-wide resource. Naming
 * one would put the server in the business of choosing between terminals with
 * none of the facts that decide it.
 */
export const ReclaimAttachmentsMessage = z.object({
  type: z.literal('reclaimAttachments'),
})
export type ReclaimAttachmentsMessage = z.infer<typeof ReclaimAttachmentsMessage>

/**
 * A host-local integration degraded in a way that needs a person's attention.
 *
 * Machine identity is deliberately absent: the gateway stamps the authenticated
 * machine principal on delivery (ADR 3 D7). A daemon cannot redirect a warning
 * to another machine or name a human in this payload.
 */
export const MachineDiagnosticMessage = z.object({
  type: z.literal('machineDiagnostic'),
  code: z.string().min(1),
  title: z.string().min(1),
  body: z.string().min(1),
  /**
   * Plain-language "what happened to me" for the attention item the server
   * raises. Optional only for compatibility with daemons that predate it;
   * without it the server has to fall back to a sentence about an unrecognized
   * integration version, which is a lie for every other kind of degradation.
   */
  description: z.string().min(1).optional(),
  observedVersion: z.string().optional(),
})
export type MachineDiagnosticMessage = z.infer<typeof MachineDiagnosticMessage>

// On-demand (chip click), not periodic — a full /proc walk is too heavy for the
// 5s hostMetrics heartbeat. `roots` are the repo/worktree paths the client controls;
// the daemon attributes non-agent processes to them by working directory.
export const MemoryBreakdownRequestMessage = z.object({
  type: z.literal('memoryBreakdownRequest'),
  requestId: z.string(),
  roots: z.array(z.string()),
})

// Who owns the used memory. Agents are attributed by process tree (the session's
// PTY/durable-host subtree); projects by working directory under a controlled root.
// Sizes are PSS where readable (shared pages divided fairly), RSS otherwise.

export const MemoryBreakdownResultMessage = z.object({
  type: z.literal('memoryBreakdownResult'),
  requestId: z.string(),
  hostname: z.string(),
  sampledAt: z.string(), // ISO 8601
  // False where the breakdown can't be computed (no /proc — macOS/Windows);
  // memory + otherBytes still carry the headline numbers.
  supported: z.boolean(),
  memory: HostMemoryWire,
  /** Capacity of the volume the daemon's home sits on. Optional: a daemon
   *  predating the field, or one whose statfs refused, ships the breakdown
   *  without it and the panel simply has no disk meter to draw. */
  disk: HostDiskWire.optional(),
  agents: z.array(AgentMemoryWire),
  projects: z.array(ProjectMemoryWire),
  // used − agents − projects: everything on the box we don't control.
  otherBytes: z.number().int().nonnegative(),
})

// A potentially multi-minute inode walk. The server derives both sets from
// registered repositories plus git's worktree registry; a web caller cannot
// point the daemon at an arbitrary path.
export const ReclaimDiskEstimateRequestMessage = z.object({
  type: z.literal('reclaimDiskEstimateRequest'),
  requestId: z.string(),
  roots: z.array(z.string()),
  reclaimRoots: z.array(z.string()),
})

export const ReclaimDiskEstimateResultMessage = z.object({
  type: z.literal('reclaimDiskEstimateResult'),
  requestId: z.string(),
  recoverableBytes: z.number().int().nonnegative().optional(),
  measuredAt: z.string().optional(),
  error: z.string().optional(),
})

// Token-usage harvest from harness transcripts (ccusage-style, in-house so it
// feeds the same wire). Hourly buckets keep the payload small while supporting
// 5h/weekly windows and per-day analytics.

export const UsageRequestMessage = z.object({
  type: z.literal('usageRequest'),
  requestId: z.string(),
  /** Only count activity at/after this epoch ms (default: 7 days back). */
  sinceMs: z.number().optional(),
})
export const UsageResultMessage = z.object({
  type: z.literal('usageResult'),
  requestId: z.string(),
  hostname: z.string(),
  /** When the daemon completed the transcript scan behind these buckets. */
  sampledAt: z.string().optional(),
  buckets: z.array(UsageBucketWire),
})

// ── Agent plan-quota (rate-limit windows). Distinct from UsageBucketWire, which
// is transcript-harvested token-cost analytics. Quota is the share of each rolling
// plan window consumed + when it resets, read live from each agent's own usage
// endpoint on the daemon host. Providers may add/remove scoped windows over time.

export const AgentQuotaRequestMessage = z.object({
  type: z.literal('agentQuotaRequest'),
  requestId: z.string(),
  refresh: z.boolean().optional(),
})
export const AgentQuotaResultMessage = z.object({
  type: z.literal('agentQuotaResult'),
  requestId: z.string(),
  hostname: z.string(),
  agents: z.array(AgentQuotaWire),
})

// ── Quota HISTORY backfill (POD-1571). Codex writes its rate-limit state into
// every session rollout and Grok logs each billing fetch, so weeks of past
// windows sit on the daemon host as a side effect of those harnesses running.
// Claude writes nothing anywhere and cannot be recovered. These samples are
// folded by the server through the same identity rule live sampling uses.

/** One recovered reading. Deliberately the RAW sample rather than a folded
 *  window: folding is the server's job, and running it in two places would be
 *  two answers to "is this the same window?". */
export const QuotaHistorySampleWire = z.object({
  agent: AgentKind,
  /** Account email when the harness files name one; absent falls back to the
   *  machine, matching `quotaAccountKey`. */
  email: z.string().optional(),
  machineId: z.string(),
  windowKey: z.string().min(1),
  label: z.string(),
  plan: z.string().optional(),
  usedPercent: z.number(),
  resetsAtMs: z.number(),
  windowMinutes: z.number().int().nonnegative(),
  atMs: z.number(),
})
export type QuotaHistorySampleWire = z.infer<typeof QuotaHistorySampleWire>

export const QuotaHistoryRequestMessage = z.object({
  type: z.literal('quotaHistoryRequest'),
  requestId: z.string(),
  /** Oldest sample worth recovering, epoch ms. */
  sinceMs: z.number(),
})
export const QuotaHistoryResultMessage = z.object({
  type: z.literal('quotaHistoryResult'),
  requestId: z.string(),
  hostname: z.string(),
  samples: z.array(QuotaHistorySampleWire),
})
