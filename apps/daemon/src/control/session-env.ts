/**
 * WHAT EACH SPAWN PATH HANDS THE ONE CHILD-ENV RECIPE (POD-6535).
 *
 * Every harness child's environment is `harnessChildEnv` (@podium/harness,
 * design §3.5). What stays here is each path's mapping of its own inputs onto
 * that recipe's three layers, plus the operator shell, which is not a harness
 * child and keeps its own path.
 *
 * This lives outside `session.ts` because the server-driver hosts need it and
 * `session.ts` imports their version probes — importing back the other way
 * would close a cycle. Nothing here may import daemon modules.
 */

import { delimiter, dirname } from 'node:path'
import { type HarnessChildEnv, type HarnessContext, harnessChildEnv } from '@podium/harness'

/**
 * THE OPERATOR SHELL'S ENV — not a harness child, so not `harnessChildEnv`.
 *
 * A shell session is the operator at their own prompt (POD-1375): nothing is
 * stripped from it, and the shell launch's env (the machine command env) keeps
 * its place above the spawn frame's env, as it always had. Podium's own
 * bindings win a collision, and the desktop-owned Podium CLI leads PATH
 * [spec:SP-d6e8]. A `PATH` in `podiumEnv` (the browser shim's folder) is a
 * prefix, as in `harnessChildEnv`, never the whole PATH.
 *
 * The result is an OVERLAY: the PTY layer spreads the daemon env under it.
 */
export function shellChildEnv(
  opts: {
    sessionEnv?: Readonly<Record<string, string>>
    launchEnv?: Readonly<Record<string, string>>
    podiumEnv: Readonly<Record<string, string>>
  },
  processEnv: NodeJS.ProcessEnv = process.env,
): Record<string, string> {
  const podiumCliPath = processEnv.PODIUM_CLI_PATH?.trim()
  const { PATH: podiumPath, ...podiumVars } = opts.podiumEnv
  const merged: Record<string, string> = {
    ...opts.sessionEnv,
    ...opts.launchEnv,
    ...podiumVars,
    ...(podiumCliPath ? { PODIUM_CLI_PATH: podiumCliPath } : {}),
  }
  const inherited = merged.PATH ?? processEnv.PATH ?? ''
  const path = [
    ...(podiumCliPath ? [dirname(podiumCliPath)] : []),
    ...(podiumPath ?? '').split(delimiter),
    ...inherited.split(delimiter),
  ]
    .filter((entry, index, entries) => entry && entries.indexOf(entry) === index)
    .join(delimiter)
  if (path) merged.PATH = path
  return merged
}

/**
 * One hosted headless turn's child env (POD-4614 ports, POD-6535 recipe).
 *
 * A headless turn has no spawn-frame env. The one credential chosen for it is
 * `credentialEnv`, the managed account the server resolved for the session's
 * owner and sent with the turn (POD-6733): it is the recipe's `sessionEnv`, so
 * it survives the strip. Every other credential the command env carries is
 * inherited and is stripped (F10). The adapter's per-invocation env (codex's MCP bearer,
 * POD-1021) and the family's overlay (claude's IS_SANDBOX as root) are wiring.
 * `instanceEnv` is what the instance decided for this turn (the relay pair,
 * a tool-less turn's pinned config folder): it rides with Podium's vars, so
 * an adapter can add to it and never override it. The account HOME comes from
 * the context and beats the wiring too (POD-3059).
 */
export function headlessTurnChildEnv(input: {
  context: HarnessContext
  credentialEnv?: Readonly<Record<string, string>>
  instanceEnv?: Readonly<Record<string, string>>
  execEnv?: Readonly<Record<string, string>>
  envOverlay?: Readonly<Record<string, string>>
}): HarnessChildEnv {
  return harnessChildEnv(input.context, {
    ...(input.credentialEnv ? { sessionEnv: input.credentialEnv } : {}),
    wiringEnv: { ...input.execEnv, ...input.envOverlay },
    ...(input.instanceEnv ? { podiumEnv: input.instanceEnv } : {}),
  })
}
