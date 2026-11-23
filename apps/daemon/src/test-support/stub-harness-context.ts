/**
 * A session harness context for rigs that run stub harness binaries
 * (POD-6546). Engines launch the context's executable and start from its
 * environment, so a rig names the stub's absolute path here and hands the
 * engine this process's own env — what the daemon's recovered command env
 * holds on a machine with no login-shell probe (it carries the rig's PATH and
 * side-channel variables to the stub).
 */
import type { HarnessContext } from '@podium/harness'
import { testHarnessContext } from '@podium/harness/driver/testing'
import type { BuiltinHarnessKind } from '@podium/protocol'

/** This process's env without unset keys: the rig's machine command env. */
export function rigCommandEnv(): Record<string, string> {
  const env: Record<string, string> = {}
  for (const [key, value] of Object.entries(process.env)) if (value !== undefined) env[key] = value
  return env
}

export function stubHarnessContext(
  kind: BuiltinHarnessKind,
  executable: string,
  options: { home?: string; version?: string } = {},
): HarnessContext {
  return testHarnessContext({
    kind,
    executable,
    ...(options.home ? { home: options.home } : {}),
    ...(options.version ? { version: options.version } : {}),
    env: rigCommandEnv(),
  })
}
