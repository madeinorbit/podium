import type { HarnessBins, HarnessExecOptions, HarnessExecSpec } from '@podium/harness'
import { harnessAdapterFor } from '@podium/harness'
import type { HarnessAgent } from '@podium/model'

/** @deprecated Unified with protocol's HarnessAgent (#158); kept as an alias. */
export type HarnessAgentKind = HarnessAgent

export type { HarnessBins, HarnessExecSpec }

/**
 * Build the CLI command + args for one non-interactive ("full harness") agent
 * turn driving the superagent. Unlike a bare `claude -p <prompt>`, this injects
 * Podium's orchestrator system prompt — natively via `--append-system-prompt`
 * where the CLI supports it, otherwise prepended to the prompt — so the agent
 * runs as our orchestrator with its real tool belt rather than a context-free
 * one-shot. Pure dispatch into the harness adapter registry (#158): each
 * adapter's `exec` is the unit-tested arg construction.
 */
export function buildHarnessExec(
  agent: HarnessAgent,
  opts: HarnessExecOptions,
  bins: HarnessBins,
): HarnessExecSpec {
  const manifest = harnessAdapterFor(agent)
  if (!manifest) throw new Error(`no harness manifest for agent kind ${String(agent)}`)
  // Declared-unsupported is a DIFFERENT failure from unknown-kind, and the message
  // says which: the harness exists, it just cannot serve a one-shot turn.
  if (!manifest.exec.supported)
    throw new Error(
      `harness ${manifest.kind} declares one-shot exec unsupported: ${manifest.exec.reason}`,
    )
  return manifest.exec.value(opts, bins)
}
