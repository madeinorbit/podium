import { HarnessAgent } from '@podium/model'
import { z } from 'zod'

// ---------------------------------------------------------------------------
// Harness identity (POD-303): OPEN on the wire, CLOSED in-repo.
// ---------------------------------------------------------------------------

/**
 * The OPEN, canonical cross-layer and wire identity of a harness: "what software
 * is this?" Any non-empty string is a valid `HarnessId`, because a newer peer may
 * name a harness this build has never heard of, and the older side must degrade
 * gracefully rather than reject the frame. On the wire a `HarnessId` always
 * travels with a serialized capability descriptor so a consumer can render a
 * harness it cannot name.
 *
 * NOT A PRINCIPAL. `HarnessId` answers "what software is this"; it never answers
 * "who is acting, and for whom". That second question is the ADR 9 D5 agent
 * PRINCIPAL — `(agentIdentity, onBehalfOf: UserId, scope)`, whose effective
 * rights are its scope intersected with its human's CURRENT rights resolved live
 * at every apply, and whose lifecycle is SessionBinding (POD-323). The two are
 * different things that would otherwise share the word "agent identity" and get
 * wired together by someone who read only one of them. Accordingly, neither
 * `HarnessId` nor `AgentManifest` (@podium/harness) carries an owner, a
 * delegation reference, a visibility class, or any other authorization concept.
 */
export const HarnessId = z.string().min(1).brand<'HarnessId'>()
export type HarnessId = z.infer<typeof HarnessId>

/**
 * The CLOSED set of harnesses this build ships a manifest for. It exists for
 * exactly ONE reason: compile-time totality of the builtin manifest registry
 * (`Record<BuiltinHarnessKind, AgentManifest>` in @podium/harness), so adding a
 * harness without declaring its manifest is a compile error. It is deliberately
 * NOT the wire type — third-party runtime plugin registration is not a goal, but
 * receiving an unknown harness name from a newer peer very much is.
 *
 * Today it is an ALIAS of `HarnessAgent`, which since POD-300 is declared once in
 * @podium/model and imported here — there is no second copy to drift. It is named
 * separately because the two have different JOBS: when the registry and the wire
 * vocabulary diverge, this is the name the registry keeps.
 */
export type BuiltinHarnessKind = HarnessAgent

/** The closed set as values, for iteration and totality tests. */
export const BUILTIN_HARNESS_KINDS: readonly BuiltinHarnessKind[] = HarnessAgent.options

/**
 * The narrowing gate between the open wire type and the closed registry. EVERY
 * lookup of a wire-supplied harness name must pass through this (or through the
 * registry's own `undefined`-returning lookup) so an unknown harness degrades to
 * "no manifest, capabilities unknown" instead of falling through to a default
 * that silently behaves like some other CLI.
 */
export function isBuiltinHarnessKind(id: string): id is BuiltinHarnessKind {
  return (BUILTIN_HARNESS_KINDS as readonly string[]).includes(id)
}

// One-shot non-interactive harness run (`claude -p` / `codex exec` / `grok -p`) — the
// harness-backed superagent/work-LLM path. Where the CLI supports it (claude,
// codex) the run mounts Podium's MCP tools via `mcpConfig`.
export const HarnessExecRequestMessage = z.object({
  type: z.literal('harnessExecRequest'),
  requestId: z.string(),
  agent: HarnessAgent,
  model: z.string().optional(),
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
