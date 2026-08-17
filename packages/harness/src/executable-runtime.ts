import type { BuiltinHarnessKind } from '@podium/protocol'
import type { HarnessExecSpec, LaunchSpec } from './manifest.js'
import type { ResolvedHarnessInventory } from './inventory/build-inventory.js'

export type HarnessInvocationSpec = Omit<LaunchSpec, 'cmd'> & { cmd?: string }
export type HarnessExecInvocationSpec = Omit<HarnessExecSpec, 'cmd'> & { cmd?: string }

function executablePath(snapshot: ResolvedHarnessInventory, kind: BuiltinHarnessKind): string {
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

export function bindHarnessLaunch(
  snapshot: ResolvedHarnessInventory,
  kind: BuiltinHarnessKind,
  invocation: HarnessInvocationSpec,
): LaunchSpec {
  return {
    ...invocation,
    cmd: executablePath(snapshot, kind),
    env: effectiveEnv(snapshot, invocation.env),
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
  snapshot: ResolvedHarnessInventory,
  kind: BuiltinHarnessKind,
): string {
  return executablePath(snapshot, kind)
}
