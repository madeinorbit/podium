// QUOTA AND MODEL PROBES PER HOME (credential management §10; epic plan Task 8,
// acceptance 7). Each home's probe reads that home: its directory variable is
// set to the home's directory in the scope the probe gets.

import type {
  HarnessAccountScope,
  HarnessContext,
  HarnessExecutableSnapshot,
} from '@podium/harness'
import { describe, expect, it } from 'vitest'
import { homeModelProbe, homeQuotaReader } from './probes'
import type { HarnessHome } from './registry'

const HOME_A: HarnessHome = {
  homeId: 'cred_a:claude-code',
  credentialId: 'cred_a',
  harness: 'claude-code',
  dir: '/state/homes/cred_a/claude-code',
}
const HOME_B: HarnessHome = {
  homeId: 'cred_b:codex',
  credentialId: 'cred_b',
  harness: 'codex',
  dir: '/state/homes/cred_b/codex',
}
const ACCOUNT = { home: '/home/person', env: { HOME: '/home/person', PATH: '/usr/bin' } }

function codexContext(): HarnessContext {
  return {
    installation: {
      kind: 'codex',
      executable: '/usr/bin/codex',
      version: '0.169.0',
      generation: 1,
      provenance: 'external',
    },
    home: ACCOUNT.home,
    env: { ...ACCOUNT.env, CODEX_HOME: '/home/person/.codex' },
    roots: { state: '/home/person/.codex' } as HarnessContext['roots'],
  }
}

describe('homeQuotaReader', () => {
  it('keeps two Google homes separate and passes the selected installation to each refresh', async () => {
    const snapshot: HarnessExecutableSnapshot = {
      executables: new Map([
        [
          'antigravity',
          {
            kind: 'antigravity',
            path: '/installed/agy',
            version: '1.5.15',
            generation: 7,
          },
        ],
      ]),
      commandEnvironment: {
        env: ACCOUNT.env,
        pathEntries: ['/usr/bin'],
        source: 'login-shell',
        generation: 7,
        machineHome: ACCOUNT.home,
        loginShell: '/bin/sh',
        resolve: () => undefined,
      },
    }
    const homes: HarnessHome[] = ['first', 'second'].map((id) => ({
      homeId: `${id}:antigravity`,
      credentialId: id,
      harness: 'antigravity',
      dir: `/state/homes/${id}/antigravity`,
    }))
    const seen: Array<string | undefined> = []
    const read = homeQuotaReader({
      homes: () => homes,
      account: async () => ({ ...ACCOUNT, snapshot }),
      fetchQuota: async (_kind, scope, deps) => {
        expect(deps.snapshot).toBe(snapshot)
        expect(scope.env.PODIUM_ANTIGRAVITY_HOME).toBe(scope.roots.credentials)
        seen.push(scope.roots.credentials)
        return {
          agent: 'antigravity',
          status: 'ok',
          windows: [],
          fetchedAt: '2026-11-23T12:00:00.000Z',
        }
      },
    })
    expect((await read(true)).map((wire) => wire.homeId)).toEqual(homes.map((home) => home.homeId))
    expect(seen).toEqual(homes.map((home) => home.dir))
  })

  it('reads each home’s quota from that home, tagged with its home id (acceptance 7)', async () => {
    const seen: Array<{ kind: string; dir: string | undefined }> = []
    const read = homeQuotaReader({
      homes: () => [HOME_A, HOME_B],
      account: async () => ACCOUNT,
      fetchQuota: async (kind, scope: HarnessAccountScope) => {
        const dir = scope.env.CLAUDE_CONFIG_DIR ?? scope.env.CODEX_HOME
        seen.push({ kind, dir })
        return {
          agent: kind as 'claude-code',
          status: 'ok',
          account: { email: `${kind}@example.invalid` },
          windows: [],
          fetchedAt: '2026-11-16T00:00:00.000Z',
        }
      },
    })
    const wires = await read(true)
    expect(wires.map((wire) => [wire.agent, wire.homeId])).toEqual([
      ['claude-code', HOME_A.homeId],
      ['codex', HOME_B.homeId],
    ])
    expect(seen).toEqual([
      { kind: 'claude-code', dir: HOME_A.dir },
      { kind: 'codex', dir: HOME_B.dir },
    ])
  })

  it('serves a recent answer without asking again, and forgets a removed home', async () => {
    let calls = 0
    let homes = [HOME_A]
    const read = homeQuotaReader({
      homes: () => homes,
      account: async () => ACCOUNT,
      fetchQuota: async (kind) => {
        calls += 1
        return { agent: kind as 'claude-code', status: 'ok', windows: [], fetchedAt: 'x' }
      },
    })
    await read(false)
    await read(false)
    expect(calls).toBe(1)
    homes = []
    expect(await read(false)).toEqual([])
  })

  it('reports a failed read as an error for that home only', async () => {
    const read = homeQuotaReader({
      homes: () => [HOME_A],
      account: async () => ACCOUNT,
      fetchQuota: async () => {
        throw new Error('signed out')
      },
    })
    expect(await read(true)).toMatchObject([
      { agent: 'claude-code', homeId: HOME_A.homeId, status: 'error', error: 'signed out' },
    ])
  })
})

describe('homeModelProbe', () => {
  it('probes each home’s models from that home, keyed by home id (acceptance 7)', async () => {
    const seen: string[] = []
    const byHome = await homeModelProbe([HOME_A, HOME_B], {
      account: ACCOUNT,
      context: (kind) => (kind === 'codex' ? codexContext() : undefined),
      probeClaude: async (account) => {
        seen.push(`claude:${account.env.CLAUDE_CONFIG_DIR}`)
        return [{ value: 'claude-model', label: 'Claude model' }]
      },
      probeAgent: async (kind, context) => {
        seen.push(`${kind}:${context.env.CODEX_HOME}`)
        return [{ value: 'codex-model', label: 'Codex model' }]
      },
    })
    expect(byHome).toEqual({
      [HOME_A.homeId]: { 'claude-code': [{ value: 'claude-model', label: 'Claude model' }] },
      [HOME_B.homeId]: { codex: [{ value: 'codex-model', label: 'Codex model' }] },
    })
    expect(seen.sort()).toEqual([`claude:${HOME_A.dir}`, `codex:${HOME_B.dir}`])
  })

  it('a home whose harness is not installed, or whose probe fails, reports nothing', async () => {
    const byHome = await homeModelProbe([HOME_A, HOME_B], {
      account: ACCOUNT,
      context: () => undefined,
      probeClaude: async () => {
        throw new Error('no token')
      },
      probeAgent: async () => [],
    })
    expect(byHome).toEqual({})
  })
})
