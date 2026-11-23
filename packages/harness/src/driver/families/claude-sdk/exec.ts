// packages/harness/src/driver/families/claude-sdk/exec.ts
//
// THE CLAUDE DURABLE-CLI TURN SHAPE (moved from
// apps/daemon/src/durable-headless.ts in 1.5: the daemon stops knowing this
// headless harness's command resolution).
//
// Two facts live here: which executable serves a durable Claude turn, and the
// `claude -p …` argv that makes it a bounded, non-interactive one. The
// supervisor owns the spawn, the journal files and the MCP file it stages;
// this module never touches the filesystem — the staged MCP path arrives as
// a value.

import { type BoundCommand, harnessCommand } from '../../../bound-command.js'
import type { HarnessContext } from '../../../harness-context-types.js'
import {
  type AgentTermsInput,
  agentLaunchTerms,
  type LaunchPosture,
} from '../../../launch-terms.js'
import { asksBypassPermissions } from './protocol.js'

/** The turn, as this family reads it: prompt facts plus supervisor facts. */
export interface ClaudeDurableTurnSpec {
  prompt: string
  model?: string
  effort?: string
  systemPrompt?: string
  contextPrompt?: string
  /** The raw MCP config JSON. Only mounted when `toolPolicy` allows tools. */
  mcpConfig?: string
  /** Fail-closed capability request. `none` removes every tool. */
  toolPolicy?: 'none'
  /** Harness session id to resume; absent = first turn. */
  resumeValue?: string
  /** Mint the first-turn session with this UUID. */
  sessionUuid?: string
}

/**
 * The `claude -p …` invocation for one durable turn.
 *
 * The real user prompt rides stdin, not argv. `--resume` continues,
 * `--session-id` mints; `toolPolicy: 'none'` removes tools, MCP and every
 * setting source rather than merely declining to mount them.
 * `knownSessionId` is the conversation this turn belongs to, for the durable
 * journal to record. argv[0] is the installation `context` pinned. The turn
 * runs on the harness's `turn` terms, or on no-agent terms when tool-less:
 * the permission mode and the allow rules are the posture section's
 * (POD-6858). This path has no bypass companion flag and no `IS_SANDBOX`, so a
 * native `bypassPermissions` pick runs as `auto` here, as it always has.
 */
export function buildClaudeDurableTurn(
  spec: ClaudeDurableTurnSpec,
  paths: { mcp: string },
  context: Pick<HarnessContext, 'installation'>,
  terms: AgentTermsInput,
): {
  command: BoundCommand
  stdin: string
  /** UNBRANDED BY DECISION: a provider/harness-native session id, not a Podium SessionId. */
  knownSessionId?: string
} {
  const instructions = [spec.systemPrompt, spec.contextPrompt]
    .map((part) => part?.trim())
    .filter(Boolean)
    .join('\n\n')
  const args = [
    '-p',
    '--verbose',
    '--output-format',
    'stream-json',
    '--include-partial-messages',
    ...(instructions ? ['--append-system-prompt', instructions] : []),
    ...(spec.model && spec.model !== 'auto' ? ['--model', spec.model] : []),
    ...(spec.effort ? ['--effort', spec.effort] : []),
    ...(spec.mcpConfig && spec.toolPolicy !== 'none' ? ['--mcp-config', paths.mcp] : []),
    ...(spec.resumeValue
      ? ['--resume', spec.resumeValue]
      : spec.sessionUuid
        ? ['--session-id', spec.sessionUuid]
        : []),
    ...(spec.toolPolicy === 'none' ? ['--setting-sources', '', '--tools', ''] : []),
  ]
  const knownSessionId = spec.resumeValue ?? spec.sessionUuid
  return {
    command: harnessCommand(
      context,
      { args },
      agentLaunchTerms(terms.manifest, 'turn', withoutBypass(terms.posture), spec.toolPolicy),
    ),
    stdin: spec.prompt,
    ...(knownSessionId ? { knownSessionId } : {}),
  }
}

/** A native `bypassPermissions` pick, as `auto`: see {@link buildClaudeDurableTurn}. */
function withoutBypass(posture: LaunchPosture): LaunchPosture {
  return asksBypassPermissions(posture.posture)
    ? { ...posture, posture: { ...posture.posture, mode: { native: 'auto' } } }
    : posture
}
