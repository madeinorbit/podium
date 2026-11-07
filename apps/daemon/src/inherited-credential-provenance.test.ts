// F10 (docs/design/harness-access-contract.md §3.5): an INHERITED credential is
// never "explicitly selected".
//
// A key counts as chosen for a session only when the server put it on the
// spawn frame (`spec.env`). Every other copy of the same variable came from the
// daemon's own environment, by way of the machine command environment, and
// would bill an account nobody picked for this session. The defect this pins:
// a path that flattens the command environment into its child env first, and
// only then asks "which credential keys are present?", finds the inherited key
// present and exempts it from the strip.
//
// Hermetic: no harness binary runs. Each case drives the daemon's own
// composition for one spawn path and reads the env it hands the process
// boundary.
import type { ResolvedHarnessInventory } from '@podium/harness'
import { testHarnessContext } from '@podium/harness/driver/testing'
import type { SessionId } from '@podium/model'
import { describe, expect, it } from 'vitest'
import { type BufferedHarnessRequest, executeBufferedHarnessTurn } from './buffered-harness.js'
import { headlessTurnChildEnv } from './control/session-env.js'
import { engineEnvBuilder } from './runtime/host.js'
import { driverHarnessContextFrom } from './session-harness-context.js'

const INHERITED = 'sk-inherited-from-the-daemon'
const CHOSEN = 'sk-chosen-for-this-session'

/** The machine command environment of a daemon started with a key exported. */
const commandEnv = Object.freeze({
  PATH: '/opt:/usr/bin:/bin',
  HOME: '/home/operator',
  ANTHROPIC_API_KEY: INHERITED,
})

function snapshotWithInheritedKey(): ResolvedHarnessInventory {
  return {
    inventory: { agents: [] },
    executables: new Map([
      ['claude-code', { kind: 'claude-code', path: '/opt/claude', generation: 3 }],
    ]),
    commandEnvironment: {
      env: commandEnv,
      pathEntries: ['/opt', '/usr/bin', '/bin'],
      source: 'inherited',
      generation: 3,
      machineHome: '/home/operator',
      loginShell: '/bin/sh',
      resolve: () => undefined,
    },
  } as unknown as ResolvedHarnessInventory
}

/** What reaches the process: the env with the strip list applied, as the
 *  host / PTY layer applies it after its merge. */
function atProcessBoundary(env: Record<string, string | undefined>, strip: readonly string[]) {
  const out = { ...env }
  for (const key of strip) delete out[key]
  return out
}

describe('an inherited credential never reaches a harness child as if it were chosen (F10)', () => {
  it('buffered exec: the command env folded into the exec env does not exempt its key', async () => {
    let childEnv: NodeJS.ProcessEnv | undefined
    const result = await executeBufferedHarnessTurn(
      { homeDir: '/state/agent-home', harnessRuntime: undefined },
      {
        type: 'harnessExecRequest',
        requestId: 'f10-buffered',
        agent: 'claude-code',
        prompt: 'summarize',
      } as BufferedHarnessRequest,
      {
        snapshot: async () => snapshotWithInheritedKey(),
        runChild: async (_cmd, _args, opts) => {
          childEnv = opts.env
          return { stdout: 'ok' }
        },
      },
    )
    expect(result.ok).toBe(true)
    expect(childEnv?.ANTHROPIC_API_KEY).toBeUndefined()
  })

  it('headless turn: the instance env built over the command env does not exempt its key', () => {
    // The daemon's two headless ports, composed as host-runtime wires them:
    // `sessionEnv` builds the turn's instance env, and `turnChildEnv` composes
    // the invocation over the turn's account context. (On the base this case
    // drove `spawnEnv` + `headlessTurnEnv`, which POD-6535 deleted; the
    // command env carrying the inherited key and the assertion are unchanged.)
    const snapshot = snapshotWithInheritedKey()
    const { env, strip } = headlessTurnChildEnv({
      context: driverHarnessContextFrom(
        { homeDir: '/state/agent-home' },
        snapshot,
        'claude-code',
        undefined,
      ),
      instanceEnv: { PODIUM_SESSION_ID: 's1' },
    })
    // The process boundary spreads the daemon env under the child env.
    expect(atProcessBoundary({ ...commandEnv, ...env }, strip).ANTHROPIC_API_KEY).toBeUndefined()
  })

  it('engine (guard): an inherited key is removed and a key on the spawn frame is kept', () => {
    const buildEnv = engineEnvBuilder(() => ({}))
    const env = buildEnv({
      sessionId: 'f10-engine' as SessionId,
      agentKind: 'claude-code',
      // A context whose account env still carries the inherited key: the strip
      // must not depend on the context builder having removed it already.
      harnessContext: testHarnessContext({ kind: 'claude-code', env: commandEnv }),
      sessionEnv: { ANTHROPIC_AUTH_TOKEN: CHOSEN },
    })
    expect(env.ANTHROPIC_API_KEY).toBeUndefined()
    expect(env.ANTHROPIC_AUTH_TOKEN).toBe(CHOSEN)
  })
})
