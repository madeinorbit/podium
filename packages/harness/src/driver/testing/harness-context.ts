/**
 * A hand-built {@link HarnessContext} for tests (POD-6533).
 *
 * The context is plain data by design, so a test that only needs a session to
 * carry one builds it here instead of standing up an inventory. The folders
 * come from the adapter's own `roots` rule over `home`, so a test that does
 * read them reads what production would for that home.
 */

import { type BuiltinHarnessKind, DEFAULT_SESSION_POSTURE } from '@podium/protocol'
import { type BoundCommand, harnessCommand } from '../../bound-command.js'
import { type HarnessContext, harnessAccount, harnessRoots } from '../../harness-context.js'
import type { LaunchPosture } from '../../launch-terms.js'
import { noAgentTerms } from '../../posture.js'
import type { HarnessAccountScope, HarnessRoots } from '../../manifest.js'

export function testHarnessContext(input: {
  kind: BuiltinHarnessKind
  home?: string
  executable?: string
  version?: string
  generation?: number
  env?: Readonly<Record<string, string>>
  /** For a harness the registry does not hold (an unregistered fixture
   *  manifest): its folders, from its own `roots` rule. */
  roots?: HarnessRoots
}): HarnessContext {
  const kind = input.kind
  const home = input.home ?? '/home/podium-test'
  const env = Object.freeze({ HOME: home, ...input.env })
  return Object.freeze({
    installation: Object.freeze({
      kind,
      executable: input.executable ?? `/opt/podium-test/bin/${kind}`,
      version: input.version ?? '',
      generation: input.generation ?? 0,
    }),
    home,
    env,
    roots: Object.freeze(input.roots ?? harnessRoots(kind, home, env)),
  })
}

/**
 * A {@link BoundCommand} for a test that spawns a stand-in program (a fixture
 * script, `/bin/sh`) at a harness spawn site. Bound through
 * {@link harnessCommand} like production, to an installation naming `cmd`, on
 * no-agent terms: a stand-in program is not an agent.
 */
export function testBoundCommand(
  cmd: string,
  args: readonly string[] = [],
  kind: BuiltinHarnessKind = 'codex',
): BoundCommand {
  return harnessCommand(
    testHarnessContext({ kind, executable: cmd }),
    { args },
    noAgentTerms('test stand-in: runs no agent'),
  )
}

/**
 * The account a test's reads run under (POD-6536): the adapter's own roots
 * rule over `home` and `env`, exactly what production hands an observer or a
 * transcript read for that account.
 */
export function testAccount(
  kind: BuiltinHarnessKind | string,
  home: string,
  env: Readonly<Record<string, string | undefined>> = {},
): HarnessAccountScope {
  return harnessAccount(kind, home, env)
}

/**
 * A launch posture for tests (POD-6858): the default session posture and
 * plain grants over `context`, so a test that builds a launch states its terms
 * the way production does without a daemon.
 */
export function testLaunchPosture(
  context: HarnessContext,
  overrides: Partial<Omit<LaunchPosture, 'context'>> = {},
): LaunchPosture {
  return {
    posture: DEFAULT_SESSION_POSTURE,
    grants: {
      podiumCli: { name: 'podium', path: '/opt/podium-test/bin/podium' },
      uploadsDir: '/var/podium-test/uploads/session',
      mcpServers: [],
    },
    workdir: '/work/podium-test',
    runtimeDir: '/run/podium-test/session',
    ...overrides,
    context,
  }
}
