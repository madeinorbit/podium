/**
 * A hand-built {@link HarnessContext} for tests (POD-6533).
 *
 * The context is plain data by design, so a test that only needs a session to
 * carry one builds it here instead of standing up an inventory. The folders
 * come from the adapter's own `roots` rule over `home`, so a test that does
 * read them reads what production would for that home.
 */

import { CLAUDE_CODE_HARNESS_KIND, HarnessAgent } from '@podium/model'
import {
  type BuiltinHarnessKind,
  DEFAULT_SESSION_POSTURE,
  type SessionPosture,
} from '@podium/protocol'
import { type BoundCommand, harnessCommand } from '../../bound-command.js'
import { type HarnessContext, harnessAccount, harnessRoots } from '../../harness-context.js'
import type { LaunchFolders, LaunchPosture } from '../../launch-terms.js'
import type { HarnessAccountScope, HarnessRoots } from '../../manifest.js'
import { noAgentTerms } from '../../posture.js'
import type { PodiumGrants } from '../../posture-types.js'

export function testHarnessContext(input: {
  kind: BuiltinHarnessKind
  home?: string
  executable?: string
  version?: string
  generation?: number
  /** Default `external`: the person's install. */
  provenance?: 'managed' | 'external'
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
      provenance: input.provenance ?? 'external',
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
  kind: BuiltinHarnessKind = HarnessAgent.enum.codex,
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
    grants: testPodiumGrants(),
    workdir: '/work/podium-test',
    runtimeDir: '/run/podium-test/session',
    ...overrides,
    context,
  }
}

/** Plain grants for a test session (POD-6858): what a daemon would build. */
export function testPodiumGrants(): PodiumGrants {
  return {
    podiumCli: { name: 'podium', path: '/opt/podium-test/bin/podium' },
    uploadsDir: '/var/podium-test/uploads/session',
    mcpServers: [],
  }
}

/** The posture and grants a test session spec carries (POD-6858). */
export function testSessionTerms(): { posture: SessionPosture; grants: PodiumGrants } {
  return { posture: DEFAULT_SESSION_POSTURE, grants: testPodiumGrants() }
}

/**
 * The two ports an engine host states its launch terms from (POD-6858), for a
 * test host: plain grants for a session with no spec in hand, and a runtime
 * folder per session (identity sections write nothing into it).
 */
export function testEngineTerms(): {
  podiumGrantsFor: (sessionId: string) => Promise<PodiumGrants>
  launchFoldersFor: (sessionId: string, workdir: string) => Promise<LaunchFolders>
} {
  return {
    podiumGrantsFor: async () => testPodiumGrants(),
    launchFoldersFor: async (sessionId) => ({ runtimeDir: `/run/podium-test/${sessionId}` }),
  }
}

/** A turn's launch posture for a test turn spec (POD-6858), over a context
 *  of harness `kind`. */
export function testTurnPosture(
  kind: BuiltinHarnessKind = CLAUDE_CODE_HARNESS_KIND,
): LaunchPosture {
  return testLaunchPosture(testHarnessContext({ kind }))
}

/** The headless host's `turnPosture` port for a test host (POD-6858): the
 *  posture the runtime resolved for the turn, over test grants and folders. */
export function testTurnPosturePort(): {
  turnPosture: (input: { agent: string; posture: SessionPosture }) => Promise<LaunchPosture>
} {
  return {
    turnPosture: async ({ agent, posture }) => ({
      ...testLaunchPosture(testHarnessContext({ kind: agent as BuiltinHarnessKind })),
      posture,
    }),
  }
}
