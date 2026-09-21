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

import type { ResolvedHarnessInventory } from '../../../inventory/build-inventory.js'
import { resolvedHarnessPath } from '../../../executable-runtime.js'
import { claudeSdkHarnessKind } from './session.js'

/** The turn, as this family reads it: prompt facts plus supervisor facts. */
export interface ClaudeDurableTurnSpec {
  prompt: string
  model?: string
  effort?: string
  systemPrompt?: string
  contextPrompt?: string
  /** The raw MCP config JSON. Only mounted when `toolPolicy` allows tools. */
  mcpConfig?: string
  allowedTools?: string[]
  permissionMode?: string
  /** Fail-closed capability request. `none` removes every tool. */
  toolPolicy?: 'none'
  /** Harness session id to resume; absent = first turn. */
  resumeValue?: string
  /** Mint the first-turn session with this UUID. */
  sessionUuid?: string
}

/** The resolved executable for a durable Claude turn, off the adapter. */
export function claudeDurableExecutable(snapshot: ResolvedHarnessInventory): string {
  return resolvedHarnessPath(snapshot, claudeSdkHarnessKind)
}

/**
 * The `claude -p …` invocation for one durable turn.
 *
 * Variadic, keep last: the real user prompt rides stdin, not argv. `--resume`
 * continues, `--session-id` mints; `toolPolicy: 'none'` removes tools, MCP
 * and every setting source rather than merely declining to mount them.
 * `knownSessionId` is the conversation this turn belongs to, for the durable
 * journal to record. The executable arrives resolved (see
 * `claudeDurableExecutable`) — argv building never resolves it twice.
 */
export function buildClaudeDurableTurn(
  spec: ClaudeDurableTurnSpec,
  paths: { mcp: string },
  executable: string,
): {
  cmd: string
  args: string[]
  stdin: string
  /** UNBRANDED BY DECISION: a provider/harness-native session id, not a Podium SessionId. */
  knownSessionId?: string
} {
  const instructions = [spec.systemPrompt, spec.contextPrompt]
    .map((part) => part?.trim())
    .filter(Boolean)
    .join('\n\n')
  const mode = spec.permissionMode === 'bypassPermissions' ? 'auto' : spec.permissionMode || 'auto'
  const args = [
    '-p',
    '--verbose',
    '--output-format',
    'stream-json',
    '--include-partial-messages',
    '--permission-mode',
    mode,
    ...(instructions ? ['--append-system-prompt', instructions] : []),
    ...(spec.model && spec.model !== 'auto' ? ['--model', spec.model] : []),
    ...(spec.effort ? ['--effort', spec.effort] : []),
    ...(spec.mcpConfig && spec.toolPolicy !== 'none' ? ['--mcp-config', paths.mcp] : []),
    ...(spec.resumeValue
      ? ['--resume', spec.resumeValue]
      : spec.sessionUuid
        ? ['--session-id', spec.sessionUuid]
        : []),
    // Variadic: keep last, and feed the real user prompt on stdin.
    ...(spec.allowedTools?.length && spec.toolPolicy !== 'none'
      ? ['--allowedTools', spec.allowedTools.join(',')]
      : []),
    ...(spec.toolPolicy === 'none' ? ['--setting-sources', '', '--tools', ''] : []),
  ]
  const knownSessionId = spec.resumeValue ?? spec.sessionUuid
  return {
    cmd: executable,
    args,
    stdin: spec.prompt,
    ...(knownSessionId ? { knownSessionId } : {}),
  }
}

/** The executable the in-process SDK path resolves for its host child. */
export function claudeSdkExecutablePath(snapshot: ResolvedHarnessInventory): string {
  return resolvedHarnessPath(snapshot, claudeSdkHarnessKind)
}
