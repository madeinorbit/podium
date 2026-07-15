import { z } from 'zod'
import { AgentKind } from './terminal'

// Memory state of a daemon host. "Available" is the kernel's estimate of memory
// applications can still allocate without swapping (Linux MemAvailable) — used is
// total − available, NOT total − free, so page cache doesn't read as pressure.
// Swap travels alongside but is never folded into the headline number.
const byteCount = z.number().int().nonnegative()
export const HostMemoryWire = z.object({
  totalBytes: byteCount,
  availableBytes: byteCount,
  swapTotalBytes: byteCount,
  swapFreeBytes: byteCount,
})
export type HostMemoryWire = z.infer<typeof HostMemoryWire>

export const HostMetricsWire = z.object({
  hostname: z.string(),
  machineId: z.string().optional(), // server-filled before broadcast
  name: z.string().optional(), // server-filled before broadcast
  sampledAt: z.string(), // ISO 8601
  memory: HostMemoryWire,
})
export type HostMetricsWire = z.infer<typeof HostMetricsWire>

export const MachineWire = z.object({
  id: z.string(),
  name: z.string(),
  hostname: z.string(),
  online: z.boolean(),
  lastSeenAt: z.string(), // ISO 8601
})
export type MachineWire = z.infer<typeof MachineWire>

export const MachinesChangedMessage = z.object({
  type: z.literal('machinesChanged'),
  machines: z.array(MachineWire),
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
  sessionId: z.string(),
  title: z.string(),
  body: z.string(),
})

// Periodic host health sample (currently every ~5 s). hostname keys the server's
// latest-per-host map so several machines' daemons can report side by side.
export const HostMetricsMessage = z.object({
  type: z.literal('hostMetrics'),
  ...HostMetricsWire.shape,
})

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
export const AgentMemoryWire = z.object({
  sessionId: z.string(),
  bytes: z.number().int().nonnegative(),
  processCount: z.number().int().nonnegative(),
})
export type AgentMemoryWire = z.infer<typeof AgentMemoryWire>
export const ProjectMemoryWire = z.object({
  root: z.string(),
  bytes: z.number().int().nonnegative(),
  processCount: z.number().int().nonnegative(),
  topProcesses: z.array(z.object({ name: z.string(), bytes: z.number().int().nonnegative() })),
})
export type ProjectMemoryWire = z.infer<typeof ProjectMemoryWire>
export const MemoryBreakdownResultMessage = z.object({
  type: z.literal('memoryBreakdownResult'),
  requestId: z.string(),
  hostname: z.string(),
  sampledAt: z.string(), // ISO 8601
  // False where the breakdown can't be computed (no /proc — macOS/Windows);
  // memory + otherBytes still carry the headline numbers.
  supported: z.boolean(),
  memory: HostMemoryWire,
  agents: z.array(AgentMemoryWire),
  projects: z.array(ProjectMemoryWire),
  // used − agents − projects: everything on the box we don't control.
  otherBytes: z.number().int().nonnegative(),
})

// Token-usage harvest from harness transcripts (ccusage-style, in-house so it
// feeds the same wire). Hourly buckets keep the payload small while supporting
// 5h/weekly windows and per-day analytics.
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
  buckets: z.array(UsageBucketWire),
})

// ── Agent plan-quota (rate-limit windows). Distinct from UsageBucketWire, which
// is transcript-harvested token-cost analytics. Quota is the share of each rolling
// plan window consumed + when it resets, read live from each agent's own usage
// endpoint on the daemon host. Providers may add/remove scoped windows over time.
export const QuotaWindowWire = z.object({
  key: z.string().min(1),
  label: z.string(),
  usedPercent: z.number(), // 0..100
  resetsAt: z.string(), // ISO 8601 ('' when unknown)
  // 0 when a provider reports a new limit without enough metadata to infer its
  // rolling duration. The UI still shows it, but omits the pace marker.
  windowMinutes: z.number().int().nonnegative(),
})
export type QuotaWindowWire = z.infer<typeof QuotaWindowWire>

export const AgentQuotaWire = z.object({
  agent: AgentKind,
  status: z.enum(['ok', 'unauthenticated', 'expired', 'error']),
  account: z.object({ email: z.string().optional(), plan: z.string().optional() }).optional(),
  windows: z.array(QuotaWindowWire),
  error: z.string().optional(),
  fetchedAt: z.string(), // ISO 8601
})
export type AgentQuotaWire = z.infer<typeof AgentQuotaWire>

// One dev machine's quota, tagged with which machine it came from. The overlay
// groups by machine because each machine runs its agents under its own account.
// The daemon↔server wire (AgentQuotaRequest/Result) stays single-machine; the
// server fans out one request per online machine and tags each reply.
export const MachineQuotaWire = z.object({
  machineId: z.string(),
  machineName: z.string(),
  hostname: z.string(),
  agents: z.array(AgentQuotaWire),
})
export type MachineQuotaWire = z.infer<typeof MachineQuotaWire>

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
