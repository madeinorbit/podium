import { HarnessAgent } from '@podium/model'
import { z } from 'zod'

// ---------------------------------------------------------------------------
// Harness identity (POD-303): OPEN on the wire, CLOSED in-repo.
//
// DEFINED IN @podium/model (entities/agent.ts) — at L0, beside AgentKind and
// HarnessAgent, so the whole harness-identity vocabulary has exactly one
// definition site. Re-exported here because `HarnessId` IS a wire type and every
// frame in this package that names a harness should be able to reach it from the
// protocol root; the re-export is a convenience, not a second declaration. Read
// the semantics — open vs closed, not-a-principal, and the static-manifest vs
// per-machine-availability split — at the definition.
// ---------------------------------------------------------------------------

export {
  BUILTIN_HARNESS_KINDS,
  type BuiltinHarnessKind,
  HarnessId,
  isBuiltinHarnessKind,
} from '@podium/model'

// One-shot non-interactive harness run (`claude -p` / `codex exec` / `grok -p`) — the
// harness-backed superagent/work-LLM path. Where the CLI supports it (claude,
// codex) the run mounts Podium's MCP tools via `mcpConfig`.
export const HarnessExecRequestMessage = z.object({
  type: z.literal('harnessExecRequest'),
  requestId: z.string(),
  agent: HarnessAgent,
  model: z.string().optional(),
  /** Provider-specific reasoning/effort variant for the one-shot run. */
  effort: z.string().optional(),
  prompt: z.string(),
  cwd: z.string().optional(),
  /** Extra system prompt injected into the harness turn (the superagent's
   *  orchestrator prompt) — natively where the CLI supports it, else prepended. */
  systemPrompt: z.string().optional(),
  /** MCP config JSON (Claude `--mcp-config`) giving the harness agent Podium's
   *  own orchestrator tools. The daemon writes it to a temp file per run. */
  mcpConfig: z.string().optional(),
  /** Tools pre-approved so they run headlessly without a permission prompt. */
  allowedTools: z.array(z.string()).optional(),
  /** Kill budget for the CLI process, ms. Superagent turns pass a long budget
   *  (multi-minute orchestration); absent = the daemon's 240s default. */
  timeoutMs: z.number().int().positive().optional(),
})
export const HarnessExecResultMessage = z.object({
  type: z.literal('harnessExecResult'),
  requestId: z.string(),
  ok: z.boolean(),
  output: z.string(),
})
