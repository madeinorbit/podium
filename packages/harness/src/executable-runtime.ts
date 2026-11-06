import type { BuiltinHarnessKind } from '@podium/protocol'
import type { HarnessContext } from './harness-context-types.js'
import type { HarnessExecSpec, LaunchSpec } from './manifest.js'
import type { ResolvedHarnessInventory } from './inventory/build-inventory.js'

export type HarnessInvocationSpec = Omit<LaunchSpec, 'cmd'> & { cmd?: string }
export type HarnessExecInvocationSpec = Omit<HarnessExecSpec, 'cmd'> & { cmd?: string }

/**
 * The narrow slice of the inventory an invocation needs: the resolved
 * executable map plus the command environment it was resolved in. Named here
 * (not in the inventory) so adapters can take it as a parameter without
 * importing the inventory mechanism — the inventory snapshot satisfies it
 * structurally, so host callers pass what they hold.
 */
export type HarnessExecutableSnapshot = Pick<
  ResolvedHarnessInventory,
  'executables' | 'commandEnvironment'
>

function executablePath(snapshot: HarnessExecutableSnapshot, kind: BuiltinHarnessKind): string {
  const executable = snapshot.executables.get(kind)
  if (!executable) throw new Error(`harness ${kind} is not installed in command-environment generation ${snapshot.commandEnvironment.generation}`)
  // Do not resolve again here. If the verified file disappeared, spawn fails against
  // this exact path instead of silently selecting a different installation.
  return executable.path
}

function effectiveEnv(
  snapshot: ResolvedHarnessInventory,
  overlay: Record<string, string> | undefined,
): Record<string, string> {
  return { ...snapshot.commandEnvironment.env, ...overlay }
}

/**
 * Bind an adapter's launch argv to ONE harness context (POD-6533): the
 * executable is the installation the context pinned, and the environment is
 * the context's account environment with the invocation's own env on top.
 *
 * Nothing here asks the inventory again. A session whose context was built
 * before an inventory refresh launches the installation it was built from.
 */
export function bindHarnessLaunch(
  context: HarnessContext,
  invocation: HarnessInvocationSpec,
): LaunchSpec {
  return {
    ...invocation,
    // Do not resolve again. If the verified file disappeared, spawn fails
    // against this exact path instead of silently selecting another one.
    cmd: context.installation.executable,
    env: { ...context.env, ...invocation.env },
  }
}

export function bindHarnessExec(
  snapshot: ResolvedHarnessInventory,
  kind: BuiltinHarnessKind,
  invocation: HarnessExecInvocationSpec,
): HarnessExecSpec {
  return {
    ...invocation,
    cmd: executablePath(snapshot, kind),
    env: effectiveEnv(snapshot, invocation.env),
  }
}

export function resolvedHarnessPath(
  snapshot: HarnessExecutableSnapshot,
  kind: BuiltinHarnessKind,
): string {
  return executablePath(snapshot, kind)
}
