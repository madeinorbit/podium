// Part of the Agent Runtime contract (POD-1761 W1). See ./index.ts for the
// surface's five governing rules and the core-vs-extended tier boundary.

import type { Declared, SelectionContext } from '@podium/harness'
import type { AgentInstruction } from '@podium/protocol'
import type { InteractionKind } from './interactions.js'

// ---------------------------------------------------------------------------
// Session specification (spec §3 `runtime.spawn`)
// ---------------------------------------------------------------------------

// `SelectionContext` — what a `select(ctx)` policy may decide on — is defined in
// `@podium/harness` beside the manifest axis that consumes it, and re-exported
// from ./families.ts. See that file for why the definition site is there.

/** The hidden, attributed instruction channel: `--append-system-prompt`,
 *  `developer_instructions`, `--rules`. Declared because the transport differs
 *  and some harnesses have none.
 *
 *  RE-PRIMED AFTER COMPACTION — that is why it is part of the SPEC rather than a
 *  launch argument: the driver owns re-delivering it at the compaction boundary
 *  reported by `{ t: 'state' }` events. */
export interface InstructionChannel {
  /** Attributed machine-authored context, kept out of the visible user turn.
   *  `AgentInstruction` is `@podium/protocol`'s existing `{ source, content }`
   *  pair — the same shape the spawn wire already carries. Reused rather than
   *  restated: a parallel instruction vocabulary is precisely the divergence the
   *  epic's pitfall list names as its biggest long-term cost. */
  instructions: readonly AgentInstruction[]
  /** Re-deliver after a compaction event closes the previous context. */
  reprimeOnCompaction: boolean
}

/** Model policy for the session. Per-turn overrides live on {@link TurnInput}
 *  and apply to ONE turn; these are STICKY for the session (spec §3 config). */
export interface ModelPolicy {
  /** Absent (or 'auto') = the harness's own default. */
  model?: string
  effort?: string
  /** Native-subagent model override, where the harness reads one. */
  subagentModel?: Declared<string>
}

/** How Podium's MCP configuration reaches the harness. Declared because the
 *  transport genuinely differs (a config path vs inline JSON) and some harnesses
 *  accept neither. */
export type McpServers = Declared<
  { transport: 'path'; path: string } | { transport: 'inline'; config: string }
>

/**
 * Everything needed to start (or restart) one session, family-independent.
 *
 * PRINCIPAL-FREE. `account` selects WHICH harness-native login to spawn under —
 * it is a harness account ref, not an authorization principal, and it carries no
 * user id, visibility class or grant. Authorization lives at the server
 * projection boundary; this package is on the machine side of that line, which
 * `manifest-principal-free` enforces.
 */
export interface SessionSpec {
  harness: string
  /** Chooses the harness-native login to spawn under; recorded on the binding.
   *  Absent = whichever account the harness itself defaults to.
   *
   *  AN OPAQUE STRING, DELIBERATELY. It names a harness account (which
   *  `~/.codex/auth.json` identity, which opencode provider key), not an
   *  authorization principal — no user id, no grant, no visibility class. The
   *  `manifest-principal-free` lint bans importing a principal type into this
   *  layer, and that ban is the point rather than an obstacle: authorization
   *  lives at the server projection boundary (POD-1079), above this package. */
  principal?: string
  selection: SelectionContext
  /** Working directory: a project or worktree path. */
  workdir: string
  model: ModelPolicy
  /** Interaction policy + permission preset for the session's role (spec §4). */
  roleProfile?: RoleProfile
  instructions: Declared<InstructionChannel>
  mcpServers: McpServers
  env?: Readonly<Record<string, string>>
  /** A first prompt delivered as part of the spawn where the harness accepts one. */
  initialPrompt?: string
}

/**
 * The per-session interaction policy's shape at the contract boundary. The
 * POLICY ENGINE is not here — W2 owns it, and the spec puts it server-side. What
 * the contract needs is the answer to "may this session stall on a startup
 * prompt", because a background executor that stalls there never starts.
 */
export interface RoleProfile {
  /** Auto-answers applied before anything escalates to a human. The spec's
   *  default for EVERY role profile: recovery → resume the FULL session;
   *  summary-resume is chosen only when the harness offers no full path. */
  autoAnswer: Partial<Record<InteractionKind, string>>
  /** How long an unanswered interaction waits before it escalates. NOT an
   *  auto-deny — the spec is explicit that `expiresAt` is an escalation
   *  deadline. */
  escalateAfterMs?: number
}
