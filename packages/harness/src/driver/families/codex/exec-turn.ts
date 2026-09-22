// packages/harness/src/driver/families/codex/exec-turn.ts
//
// THE CODEX HEADLESS TURN'S INVOCATION: `codex exec --json` (moved from
// apps/daemon/src/headless-drivers.ts in 1.5: the daemon stops knowing this
// headless harness's turn shape).
//
// TRANSPORT NOTE (carried over): the design names `codex app-server` JSON-RPC
// as the target surface; this ships the exec --json variant because its event
// stream (`thread.started`/`item.*`/`turn.completed`) was VERIFIED against a
// real CLI, while the app-server handshake specifics were not.
//
// Only the argv lives here (read off the adapter's `headless.buildExec`
// section, never restated). The turn itself runs under podium-host like every
// one-shot turn (../headless/turn.ts, POD-4614), and its JSONL fold is the
// headless family's `codex-jsonl` reader: this family no longer holds a child
// process, a spawn port or a kill. First turn is `codex exec --json`, turns ≥2
// resume the journalled thread.

import { bindHarnessExec } from '../../../executable-runtime.js'
import type { ResolvedHarnessInventory } from '../../../inventory/build-inventory.js'
import { declaredValue, type AgentManifest, type HeadlessExecOptions } from '../../../manifest.js'

/**
 * Pure argv builder for the codex-json turn, so the exact invocation shape is
 * unit-testable. Reads the HANDED headless section: the adapter's
 * `headless.buildExec` owns the CLI's invocation shape.
 */
export function buildCodexExecTurn(
  opts: HeadlessExecOptions,
  snapshot: ResolvedHarnessInventory,
  sections: Pick<AgentManifest, 'headless'>,
): { cmd: string; args: string[]; env?: Record<string, string> } {
  const headless = declaredValue(sections.headless)
  const buildExec = headless && declaredValue(headless.buildExec)
  if (!buildExec) throw new Error('codex adapter has no headless exec builder')
  return bindHarnessExec(snapshot, 'codex', buildExec({ ...opts, env: opts.env ?? snapshot.commandEnvironment.env }))
}
