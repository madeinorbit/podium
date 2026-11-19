// SERVER-DRIVER ENGINES RUN IN THEIR SESSION'S HOME (credential management
// §10; epic plan Task 8, acceptance 6 as the coordinator restated it):
// engines stay one per session; two sessions in one home both run in that
// home; sessions in two homes run in two. The engine's context and child env
// are built the way the engine hosts build them (engineSessionHarnessContext,
// then engineEnvBuilder over harnessChildEnv).

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { asSessionId } from '@podium/model'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { memoryMarkers, SessionAccessStore } from '../control/access'
import type { DaemonContext } from '../control/context'
import { DaemonHarnessRuntime } from '../harness-runtime'
import { engineEnvBuilder } from '../runtime/host'
import { testSessions } from '../session/testing.js'
import { engineSessionHarnessContext } from '../session-harness-context'
import { testHarnessSnapshot } from '../test-support/harness-snapshot'
import { HomeRegistry } from './registry'

const CRED_A = 'cred_aaaaaaaa-0000-4000-8000-0000000000e6'
const CRED_B = 'cred_bbbbbbbb-0000-4000-8000-0000000000e6'

let root: string
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'podium-home-engines-'))
})
afterEach(() => rmSync(root, { recursive: true, force: true }))

async function world() {
  const homes = new HomeRegistry({ root: join(root, 'homes') })
  const access = new SessionAccessStore({ markers: memoryMarkers() })
  const ctx = {
    harnessRuntime: new DaemonHarnessRuntime({
      buildSnapshot: async (n) => testHarnessSnapshot({}, n),
    }),
    homeDir: join(root, 'person'),
    sessions: testSessions(),
    access,
    homes,
  } as unknown as DaemonContext
  const envOf = engineEnvBuilder(() => ({}))
  const engineEnv = async (
    sessionId: string,
    kind: 'claude-code' | 'codex',
    sessionEnv?: Record<string, string>,
  ) => {
    const id = asSessionId(sessionId)
    const harnessContext = await engineSessionHarnessContext(ctx, id, kind, undefined)
    return envOf({
      sessionId: id,
      agentKind: kind,
      harnessContext,
      ...(sessionEnv ? { sessionEnv } : {}),
    })
  }
  return { ctx, homes, access, engineEnv }
}

describe('engines per session, each in its session’s home (acceptance 6)', () => {
  it('two sessions in one home both run in it; a session in another home runs in that one', async () => {
    const { homes, access, engineEnv } = await world()
    const a = (await homes.ensure(CRED_A, 'codex')).home
    const b = (await homes.ensure(CRED_B, 'codex')).home
    const inHome = (credentialId: string, homeId: string) => ({
      credentialId,
      delivery: { kind: 'home' as const, homeId },
    })
    access.remember(asSessionId('one'), inHome(CRED_A, a.homeId), 'codex')
    access.remember(asSessionId('two'), inHome(CRED_A, a.homeId), 'codex')
    access.remember(asSessionId('three'), inHome(CRED_B, b.homeId), 'codex')

    const [one, two, three] = await Promise.all([
      engineEnv('one', 'codex'),
      engineEnv('two', 'codex'),
      engineEnv('three', 'codex'),
    ])
    expect(one.CODEX_HOME).toBe(a.dir)
    expect(two.CODEX_HOME).toBe(a.dir)
    expect(three.CODEX_HOME).toBe(b.dir)
    expect(one.PODIUM_SESSION_ID).toBe('one')
    expect(two.PODIUM_SESSION_ID).toBe('two')
  })

  it('the Claude stream engine’s pinned config folder yields to the home', async () => {
    const { homes, access, engineEnv } = await world()
    const a = (await homes.ensure(CRED_A, 'claude-code')).home
    access.remember(
      asSessionId('claude'),
      { credentialId: CRED_A, delivery: { kind: 'home', homeId: a.homeId } },
      'claude-code',
    )
    // engine-host.ts pins the instance's own `.claude` in the session env.
    const pinned = { CLAUDE_CONFIG_DIR: join(root, 'person', '.claude') }
    expect((await engineEnv('claude', 'claude-code', pinned)).CLAUDE_CONFIG_DIR).toBe(a.dir)
  })

  it('an engine for a session without a home runs in the harness’s own directory', async () => {
    const { engineEnv } = await world()
    expect((await engineEnv('plain', 'codex')).CODEX_HOME).toBe(join(root, 'person', '.codex'))
  })
})
