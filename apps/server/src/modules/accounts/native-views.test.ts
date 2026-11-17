import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { asMachineId, Inventory } from '@podium/model'
import type { HarnessDescriptorWire } from '@podium/protocol'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { MachineRecord } from '../../store/types'
import { nativeAccountViews } from './native-views'

let home: string
let codexHome: string
const prevCodexHome = process.env.CODEX_HOME
const prevGrokHome = process.env.GROK_HOME
const prevClaudeConfigDir = process.env.CLAUDE_CONFIG_DIR

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'acct-home-'))
  codexHome = mkdtempSync(join(tmpdir(), 'acct-codex-'))
  process.env.CODEX_HOME = codexHome
  delete process.env.GROK_HOME
  delete process.env.CLAUDE_CONFIG_DIR
})
afterEach(() => {
  rmSync(home, { recursive: true, force: true })
  rmSync(codexHome, { recursive: true, force: true })
  if (prevCodexHome === undefined) delete process.env.CODEX_HOME
  else process.env.CODEX_HOME = prevCodexHome
  if (prevGrokHome === undefined) delete process.env.GROK_HOME
  else process.env.GROK_HOME = prevGrokHome
  if (prevClaudeConfigDir === undefined) delete process.env.CLAUDE_CONFIG_DIR
  else process.env.CLAUDE_CONFIG_DIR = prevClaudeConfigDir
})

function machineWithLogin(
  state: 'in' | 'out' | 'unknown',
  account?: string,
  id = 'machine-no-fingerprint',
): MachineRecord {
  return {
    id: asMachineId(id),
    name: id,
    hostname: id,
    revokedAt: null,
    createdAt: '2026-08-06T00:00:00.000Z',
    lastSeenAt: '2026-08-06T00:00:00.000Z',
    podiumManaged: true,
    updateChannelOverride: null,
    appVersion: null,
    wireSchemaDigest: null,
    installKind: null,
    deliveryCaps: [],
    presenceSource: null,
    assignmentEvidence: null,
    availability: null,
    serviceAssignment: { server: false, agentExecution: true },
    serviceReport: null,
    buildReportedAt: null,
    components: ['daemon'],
    inventory: Inventory.parse({
      os: 'linux',
      arch: 'x64',
      agents: [
        {
          kind: 'claude-code',
          installed: true,
          login: { state, ...(account ? { account } : {}) },
        },
      ],
    }),
  }
}

function jwt(payload: Record<string, unknown>): string {
  return `header.${Buffer.from(JSON.stringify(payload)).toString('base64url')}.signature`
}

describe('nativeAccountViews', () => {
  it('trusts an explicit logged-in report even when an older daemon omits identity metadata', async () => {
    const claude = nativeAccountViews([machineWithLogin('in', 'mike@example.com')]).find(
      (view) => view.id === 'native:claude-code',
    )!

    expect(claude).toMatchObject({
      status: 'connected',
      identity: 'mike@example.com',
      machines: ['machine-no-fingerprint'],
    })
  })

  it('distinguishes an unavailable native status from an explicit logout', async () => {
    const unknown = nativeAccountViews([machineWithLogin('unknown')]).find(
      (view) => view.id === 'native:claude-code',
    )!
    const loggedOut = nativeAccountViews([machineWithLogin('out')]).find(
      (view) => view.id === 'native:claude-code',
    )!

    expect(unknown.status).toBe('unknown')
    expect(loggedOut.status).toBe('not-configured')
  })

  it('does not claim a fleet logout while another machine has an unknown status', async () => {
    const claude = nativeAccountViews([
      machineWithLogin('out', undefined, 'logged-out'),
      machineWithLogin('unknown', undefined, 'unreported'),
    ]).find((view) => view.id === 'native:claude-code')!

    expect(claude.status).toBe('unknown')
  })

  it('reports native logins as not-configured when nothing is present', async () => {
    const views = nativeAccountViews(home)
    const claude = views.find((v) => v.id === 'native:claude-code')!
    expect(claude.status).toBe('not-configured')
    expect(views.find((v) => v.id === 'native:codex')!.status).toBe('not-configured')
    expect(views.find((v) => v.id === 'native:grok')!.status).toBe('not-configured')
  })

  it('detects a Claude login and surfaces the email as identity', async () => {
    mkdirSync(join(home, '.claude'))
    writeFileSync(join(home, '.claude', '.credentials.json'), JSON.stringify({ oauth: 'token' }))
    writeFileSync(
      join(home, '.claude.json'),
      JSON.stringify({ oauthAccount: { emailAddress: 'mike@example.com' } }),
    )
    const claude = nativeAccountViews(home).find((v) => v.id === 'native:claude-code')!
    expect(claude.status).toBe('connected')
    expect(claude.identity).toBe('mike@example.com')
    expect(claude.source).toBe('native')
  })

  it('surfaces the Codex ID-token profile instead of its account id', async () => {
    // The single-home path reads the home it is given, never an ambient CODEX_HOME.
    mkdirSync(join(home, '.codex'), { recursive: true })
    writeFileSync(
      join(home, '.codex', 'auth.json'),
      JSON.stringify({
        tokens: {
          access_token: 'access',
          refresh_token: 'refresh',
          account_id: 'account-id-that-should-not-display',
          id_token: jwt({ name: 'Mike Example', email: 'mike@example.com' }),
        },
      }),
    )
    const codex = nativeAccountViews(home).find((view) => view.id === 'native:codex')!
    expect(codex.identity).toBe('Mike Example · mike@example.com')
    expect(codex.identity).not.toContain('account-id')
  })

  it('surfaces the Grok profile from its local auth record', async () => {
    mkdirSync(join(home, '.grok'))
    writeFileSync(
      join(home, '.grok', 'auth.json'),
      JSON.stringify({
        'https://auth.x.ai::account': {
          key: 'credential',
          first_name: 'Grace',
          last_name: 'Hopper',
          email: 'grace@example.com',
        },
      }),
    )
    const grok = nativeAccountViews(home).find((view) => view.id === 'native:grok')!
    expect(grok.status).toBe('connected')
    expect(grok.identity).toBe('Grace Hopper · grace@example.com')
  })
})

describe('nativeAccountViews catalog', () => {
  function opencodeMachine(state: 'in' | 'out'): MachineRecord {
    return {
      id: asMachineId(`opencode-${state}`),
      name: `opencode-${state}`,
      hostname: `opencode-${state}`,
      revokedAt: null,
      createdAt: '2026-08-30T00:00:00.000Z',
      lastSeenAt: '2026-08-30T00:00:00.000Z',
      podiumManaged: true,
      updateChannelOverride: null,
      appVersion: null,
      wireSchemaDigest: null,
      installKind: null,
      deliveryCaps: [],
      presenceSource: null,
      assignmentEvidence: null,
      availability: null,
      serviceAssignment: { server: false, agentExecution: true },
      serviceReport: null,
      buildReportedAt: null,
      components: ['daemon'],
      inventory: Inventory.parse({
        os: 'linux',
        arch: 'x64',
        agents: [
          {
            kind: 'opencode',
            installed: true,
            login: {
              state,
              ...(state === 'in' ? { account: 'OpenCode · synthetic-provider' } : {}),
            },
          },
        ],
      }),
    }
  }

  it('projects OpenCode inventory login state into a native account row', async () => {
    const connected = nativeAccountViews([opencodeMachine('in')]).find(
      (view) => view.id === 'native:opencode',
    )
    const loggedOut = nativeAccountViews([opencodeMachine('out')]).find(
      (view) => view.id === 'native:opencode',
    )

    expect(connected).toMatchObject({
      provider: 'opencode',
      harness: 'opencode',
      identity: 'OpenCode · synthetic-provider',
      machines: ['opencode-in'],
      status: 'connected',
    })
    expect(loggedOut).toMatchObject({ status: 'not-configured' })
  })

  function catalogMachine(
    id: string,
    name: string,
    fingerprint: string,
    email: string,
  ): MachineRecord {
    return {
      id: asMachineId(id),
      name,
      hostname: name,
      revokedAt: null,
      createdAt: '2026-08-04T00:00:00.000Z',
      lastSeenAt: '2026-08-04T00:00:00.000Z',
      podiumManaged: true,
      updateChannelOverride: null,
      // Nothing has reported a build for these fixtures — the shape a machine
      // row carries before its daemon hands up version/delivery detail.
      appVersion: null,
      wireSchemaDigest: null,
      installKind: null,
      deliveryCaps: [],
      presenceSource: null,
      assignmentEvidence: null,
      availability: null,
      serviceAssignment: { server: false, agentExecution: true },
      serviceReport: null,
      buildReportedAt: null,
      components: ['daemon'],
      inventory: Inventory.parse({
        os: 'linux',
        arch: 'x64',
        agents: [
          {
            kind: 'codex',
            installed: true,
            login: { state: 'in', account: email, identity: { fingerprint, email } },
          },
        ],
      }),
    }
  }

  it('keys native accounts by identity and lists every holding machine', async () => {
    const views = nativeAccountViews([
      catalogMachine('m1', 'macbook', 'fp-a', 'a@example.com'),
      catalogMachine('m2', 'vmi', 'fp-a', 'a@example.com'),
      catalogMachine('m3', 'linux-box', 'fp-b', 'b@example.com'),
    ])
    const native = views.filter((view) => view.harness === 'codex')

    expect(native.map((view) => view.id)).toEqual(['native:codex:fp-a', 'native:codex:fp-b'])
    expect(native[0]).toMatchObject({
      identity: 'a@example.com',
      identityFingerprint: 'fp-a',
      machines: ['macbook', 'vmi'],
      status: 'connected',
    })
    expect(native[1]).toMatchObject({
      identity: 'b@example.com',
      identityFingerprint: 'fp-b',
      machines: ['linux-box'],
      status: 'connected',
    })
  })
})

describe('nativeAccountViews provider source (POD-4529)', () => {
  /** A served descriptor that disagrees with every hand-written table: the
   *  row must carry the SERVED value, proving the server reads the report. */
  function servedWithProvider(kind: string, provider: string): HarnessDescriptorWire[] {
    return [
      {
        schemaVersion: 1,
        kind,
        provider,
        label: `${kind} label`,
        shortLabel: kind,
        icon: { id: kind, viewBox: '0 0 24 24', d: 'M0 0h24v24H0z' },
        capabilities: { argvPrompt: true, effort: true, systemPrompt: true },
        catalog: { models: [], efforts: [], liveMerge: 'live-wins-when-non-empty' },
        accepts: [],
      },
    ]
  }

  it('reads the catalog-path provider off the served descriptor', async () => {
    const views = nativeAccountViews(
      [machineWithLogin('in', 'mike@example.com')],
      servedWithProvider('claude-code', 'served-provider-x'),
    )
    expect(views.find((view) => view.id === 'native:claude-code')!.provider).toBe(
      'served-provider-x',
    )
  })

  it('reads the legacy HOME-path provider off the served descriptor', async () => {
    const views = nativeAccountViews(home, servedWithProvider('codex', 'served-provider-y'))
    expect(views.find((view) => view.id === 'native:codex')!.provider).toBe('served-provider-y')
  })

  it('falls back to the bundled descriptor when no machine reported one', async () => {
    const views = nativeAccountViews([machineWithLogin('in', 'mike@example.com')])
    expect(views.find((view) => view.id === 'native:claude-code')!.provider).toBe('anthropic')
    expect(views.find((view) => view.id === 'native:opencode')!.provider).toBe('opencode')
  })

  it('an older daemon descriptor without provider falls back to kind (POD-4542)', async () => {
    // Cross-version acceptance at the server reader: a POD-4475 frame
    // carries no `provider`, and nativePairs resolves it through the ONE
    // shared `providerOf` rule — the same rule the parsers use.
    const [served] = servedWithProvider('claude-code', 'served-provider-x')
    const { provider: _p, ...older } = served!
    void _p
    const views = nativeAccountViews([machineWithLogin('in', 'mike@example.com')], [older])
    expect(views.find((view) => view.id === 'native:claude-code')!.provider).toBe('claude-code')
  })
})
