/**
 * THE RESOLVER (credential management spec §9, epic plan Task 3).
 *
 * One table row per refusal this task raises and per delivery, read through a
 * real store and vault. Every row's serialized result is searched for the
 * planted secret, after a canary proves the search finds it where it is.
 */

import { harnessTerminalDriverId } from '@podium/harness'
import {
  type AgentKind,
  asMachineId,
  asUserId,
  type CredentialId,
  firstAdminMemberId,
  type MachineId,
  type UserId,
} from '@podium/model'
import { afterEach, describe, expect, it } from 'vitest'
import type { SessionStore } from '../../store'
import { openTestStore } from '../../test-support/open-test-store'
import {
  ACCESS_REFUSAL_MESSAGES,
  type AccessRefusal,
  resolveInferenceAccess,
  resolveSessionAccess,
  type SessionAccess,
} from './access'
import { sealCredentialSecret, withSecret } from './vault'

const OWNER = asUserId('user:access-owner')
const OTHER = asUserId('user:access-other')
const OWN_MACHINE = asMachineId('machine-access-own')
const OTHERS_MACHINE = asMachineId('machine-access-others')
/** Obviously fake. */
const PLANTED = 'sk-FAKE-planted-access-secret-0000'

let store: SessionStore | undefined
afterEach(async () => {
  await store?.close()
  store = undefined
})

async function machine(
  s: SessionStore,
  id: MachineId,
  custodian: UserId,
  logins: { kind: AgentKind; fingerprint: string }[] = [],
): Promise<void> {
  await s.machines.upsertMachine({
    id,
    name: id,
    hostname: id,
    tokenHash: 'test',
    ownerUserId: custodian,
    assignment: { server: false, agentExecution: true },
  })
  await s.machines.setMachineInventory(
    id,
    JSON.stringify({
      os: 'linux',
      arch: 'x64',
      tools: [],
      agents: logins.map((l) => ({
        kind: l.kind,
        installed: true,
        login: { state: 'in', identity: { fingerprint: l.fingerprint } },
      })),
    }),
  )
}

async function open(): Promise<SessionStore> {
  store = await openTestStore(':memory:')
  await machine(store, OWN_MACHINE, OWNER, [{ kind: 'claude-code', fingerprint: 'fp-claude' }])
  await machine(store, OTHERS_MACHINE, OTHER)
  return store
}

async function vaultCredential(
  s: SessionStore,
  type: string,
  owner: UserId = OWNER,
): Promise<CredentialId> {
  const record = await s.credentials.insert({ ownerUserId: owner, label: type, type })
  expect(await sealCredentialSecret(s, record, PLANTED, 0)).toBe(1)
  return record.id
}

async function loginCredential(s: SessionStore, fingerprint: string): Promise<CredentialId> {
  const record = await s.credentials.insert({
    ownerUserId: OWNER,
    label: 'Claude login',
    type: 'anthropic.claude-login',
    identity: { fingerprint },
  })
  return record.id
}

async function refusalsRecorded(s: SessionStore): Promise<string[]> {
  const rows = await s.settingsAudit.list(100)
  return rows
    .filter((row) => row.command === 'credentials.refuse')
    .map((row) => String((row.detail as { detail?: string }).detail))
}

describe('resolveSessionAccess', () => {
  it('can find the planted secret where it is stored (canary)', async () => {
    const s = await open()
    const id = await vaultCredential(s, 'anthropic.api-key')
    const opened = await withSecret(s, id, async (secret) => JSON.stringify({ secret }))
    expect(opened).toContain(PLANTED)
  })

  type Row = {
    name: string
    setup: (s: SessionStore) => Promise<{
      harness: AgentKind
      driverId?: string
      credentialId: CredentialId | null
      actingUserId: UserId
      machineId: MachineId
    }>
    expected: SessionAccess
  }

  const refused = (refusal: AccessRefusal): SessionAccess => ({
    ok: false,
    refusal,
    message: ACCESS_REFUSAL_MESSAGES[refusal],
  })

  const missing = 'cred_00000000-0000-4000-8000-000000000000' as CredentialId

  const rows: Row[] = [
    {
      name: 'not-found',
      setup: async () => ({
        harness: 'claude-code',
        credentialId: missing,
        actingUserId: OWNER,
        machineId: OWN_MACHINE,
      }),
      expected: refused('not-found'),
    },
    {
      name: 'revoked',
      setup: async (s) => {
        const id = await vaultCredential(s, 'anthropic.api-key')
        await s.credentials.remove(id)
        return {
          harness: 'claude-code',
          credentialId: id,
          actingUserId: OWNER,
          machineId: OWN_MACHINE,
        }
      },
      expected: refused('revoked'),
    },
    {
      name: 'not-yours',
      setup: async (s) => ({
        harness: 'claude-code',
        credentialId: await vaultCredential(s, 'anthropic.api-key', OTHER),
        actingUserId: OWNER,
        machineId: OWN_MACHINE,
      }),
      expected: refused('not-yours'),
    },
    {
      name: 'wrong-type',
      setup: async (s) => ({
        harness: 'codex',
        credentialId: await vaultCredential(s, 'anthropic.api-key'),
        actingUserId: OWNER,
        machineId: OWN_MACHINE,
      }),
      expected: refused('wrong-type'),
    },
    {
      name: 'wrong-type (a line limited to another driver)',
      setup: async (s) => ({
        harness: 'codex',
        credentialId: await vaultCredential(s, 'openai.chatgpt-plan'),
        actingUserId: OWNER,
        machineId: OWN_MACHINE,
      }),
      expected: refused('wrong-type'),
    },
    {
      name: 'wrong-type (the plan on the Codex terminal driver, Task 15 acceptance 2)',
      setup: async (s) => ({
        harness: 'codex',
        driverId: harnessTerminalDriverId('codex') ?? 'no-codex-terminal-driver',
        credentialId: await vaultCredential(s, 'openai.chatgpt-plan'),
        actingUserId: OWNER,
        machineId: OWN_MACHINE,
      }),
      expected: refused('wrong-type'),
    },
    {
      name: 'not-on-this-machine',
      setup: async (s) => ({
        harness: 'claude-code',
        credentialId: await loginCredential(s, 'fp-elsewhere'),
        actingUserId: OWNER,
        machineId: OWN_MACHINE,
      }),
      expected: refused('not-on-this-machine'),
    },
    {
      name: 'machine-not-allowed',
      setup: async (s) => ({
        harness: 'claude-code',
        credentialId: await vaultCredential(s, 'anthropic.api-key'),
        actingUserId: OWNER,
        machineId: OTHERS_MACHINE,
      }),
      expected: refused('machine-not-allowed'),
    },
    {
      name: 'own-credential-required',
      setup: async () => ({
        harness: 'claude-code',
        credentialId: null,
        actingUserId: OWNER,
        machineId: OTHERS_MACHINE,
      }),
      expected: refused('own-credential-required'),
    },
    {
      name: 'needs-attention',
      setup: async (s) => {
        const id = await vaultCredential(s, 'anthropic.api-key')
        await s.credentials.setStatus(id, 'attention', 'expired')
        return {
          harness: 'claude-code',
          credentialId: id,
          actingUserId: OWNER,
          machineId: OWN_MACHINE,
        }
      },
      expected: refused('needs-attention'),
    },
    {
      name: 'the default home, with no credential',
      setup: async () => ({
        harness: 'claude-code',
        credentialId: null,
        actingUserId: OWNER,
        machineId: OWN_MACHINE,
      }),
      expected: { ok: true, credentialId: null, delivery: { kind: 'home', homeId: 'default' } },
    },
  ]

  for (const row of rows) {
    it(`refuses or delivers: ${row.name}`, async () => {
      const s = await open()
      const input = await row.setup(s)
      const result = await resolveSessionAccess(s, input)
      expect(result).toEqual(row.expected)
      expect(JSON.stringify(result)).not.toContain(PLANTED)
      if (!result.ok) expect(await refusalsRecorded(s)).toEqual([result.refusal])
      else expect(await refusalsRecorded(s)).toEqual([])
    })
  }

  it('delivers a home credential whose identity the machine reports to the default home', async () => {
    const s = await open()
    const id = await loginCredential(s, 'fp-claude')
    const result = await resolveSessionAccess(s, {
      harness: 'claude-code',
      credentialId: id,
      actingUserId: OWNER,
      machineId: OWN_MACHINE,
    })
    expect(result).toEqual({
      ok: true,
      credentialId: id,
      delivery: { kind: 'home', homeId: 'default' },
    })
  })

  it('delivers a second subscription to the Podium home that holds it (Task 9)', async () => {
    const s = await open()
    const id = await loginCredential(s, 'fp-claude-second')
    const homeId = `${id}:claude-code`
    await s.machines.setMachineInventory(
      OWN_MACHINE,
      JSON.stringify({
        os: 'linux',
        arch: 'x64',
        tools: [],
        agents: [
          {
            kind: 'claude-code',
            installed: true,
            login: { state: 'in', identity: { fingerprint: 'fp-claude' } },
            logins: [
              { homeId: 'default', state: 'in', identity: { fingerprint: 'fp-claude' } },
              { homeId: 'cred_other:claude-code', state: 'out' },
              { homeId, state: 'in', identity: { fingerprint: 'fp-claude-second' } },
            ],
          },
        ],
      }),
    )
    expect(
      await resolveSessionAccess(s, {
        harness: 'claude-code',
        credentialId: id,
        actingUserId: OWNER,
        machineId: OWN_MACHINE,
      }),
    ).toEqual({ ok: true, credentialId: id, delivery: { kind: 'home', homeId } })
    // The default home's own login still goes to the default home.
    const first = await loginCredential(s, 'fp-claude')
    expect(
      await resolveSessionAccess(s, {
        harness: 'claude-code',
        credentialId: first,
        actingUserId: OWNER,
        machineId: OWN_MACHINE,
      }),
    ).toMatchObject({ ok: true, delivery: { kind: 'home', homeId: 'default' } })
  })

  it('refuses a Podium home that reports the account signed out', async () => {
    const s = await open()
    const id = await loginCredential(s, 'fp-claude-out')
    await s.machines.setMachineInventory(
      OWN_MACHINE,
      JSON.stringify({
        os: 'linux',
        arch: 'x64',
        tools: [],
        agents: [
          {
            kind: 'claude-code',
            installed: true,
            login: { state: 'out' },
            logins: [
              { homeId: 'default', state: 'out' },
              {
                homeId: `${id}:claude-code`,
                state: 'out',
                identity: { fingerprint: 'fp-claude-out' },
              },
            ],
          },
        ],
      }),
    )
    expect(
      await resolveSessionAccess(s, {
        harness: 'claude-code',
        credentialId: id,
        actingUserId: OWNER,
        machineId: OWN_MACHINE,
      }),
    ).toMatchObject({ ok: false, refusal: 'not-on-this-machine' })
  })

  const envRows: { harness: AgentKind; type: string; variable: string; driverId?: string }[] = [
    { harness: 'claude-code', type: 'anthropic.api-key', variable: 'ANTHROPIC_API_KEY' },
    { harness: 'claude-code', type: 'anthropic.claude-token', variable: 'CLAUDE_CODE_OAUTH_TOKEN' },
    { harness: 'codex', type: 'openai.api-key', variable: 'OPENAI_API_KEY' },
    {
      harness: 'codex',
      type: 'openai.chatgpt-plan',
      variable: 'ACCESS_TOKEN',
      driverId: 'codex-app-server',
    },
    { harness: 'opencode', type: 'anthropic.api-key', variable: 'ANTHROPIC_API_KEY' },
    { harness: 'opencode', type: 'openai.api-key', variable: 'OPENAI_API_KEY' },
    { harness: 'opencode', type: 'openrouter.api-key', variable: 'OPENROUTER_API_KEY' },
    { harness: 'pi', type: 'anthropic.api-key', variable: 'ANTHROPIC_API_KEY' },
    { harness: 'pi', type: 'openai.api-key', variable: 'OPENAI_API_KEY' },
    { harness: 'pi', type: 'openrouter.api-key', variable: 'OPENROUTER_API_KEY' },
  ]

  for (const row of envRows) {
    it(`delivers ${row.type} to ${row.harness} as ${row.variable}`, async () => {
      const s = await open()
      const id = await vaultCredential(s, row.type)
      const result = await resolveSessionAccess(s, {
        harness: row.harness,
        ...(row.driverId ? { driverId: row.driverId } : {}),
        credentialId: id,
        actingUserId: OWNER,
        machineId: OWN_MACHINE,
      })
      expect(result).toEqual({
        ok: true,
        credentialId: id,
        delivery: { kind: 'env', variable: row.variable },
      })
      expect(JSON.stringify(result)).not.toContain(PLANTED)
    })
  }
})

describe('the machine rule (review focus 7)', () => {
  it("refuses the owner's credential where the owner only uses the machine, until allowed", async () => {
    const s = await open()
    const id = await vaultCredential(s, 'anthropic.api-key')
    const input = {
      harness: 'claude-code' as const,
      credentialId: id,
      actingUserId: OWNER,
      machineId: OTHERS_MACHINE,
    }
    expect(await resolveSessionAccess(s, input)).toMatchObject({
      ok: false,
      refusal: 'machine-not-allowed',
    })
    await s.credentials.allowMachine(id, OTHERS_MACHINE, OWNER)
    expect(await resolveSessionAccess(s, input)).toMatchObject({ ok: true, credentialId: id })
  })

  it('resolves on a machine the owner holds custody of without an allowance', async () => {
    const s = await open()
    const id = await vaultCredential(s, 'anthropic.api-key')
    expect(
      await resolveSessionAccess(s, {
        harness: 'claude-code',
        credentialId: id,
        actingUserId: OWNER,
        machineId: OWN_MACHINE,
      }),
    ).toMatchObject({ ok: true, credentialId: id })
  })

  it('treats an admin without custody like a use holder', async () => {
    const s = await open()
    // The first admin of a fresh store: an admin by role, no custody of OTHER's machine.
    const adminId = await firstAdminMemberId(s)
    const id = await vaultCredential(s, 'anthropic.api-key', adminId)
    const input = {
      harness: 'claude-code' as const,
      credentialId: id,
      actingUserId: adminId,
      machineId: OTHERS_MACHINE,
    }
    expect(await resolveSessionAccess(s, input)).toMatchObject({
      ok: false,
      refusal: 'machine-not-allowed',
    })
    expect(await resolveSessionAccess(s, { ...input, credentialId: null })).toMatchObject({
      ok: false,
      refusal: 'own-credential-required',
    })
  })
})

describe('a machine nobody holds custody of (MU-10)', () => {
  it('runs nothing on its logins, and no credential its owner has not sent there', async () => {
    const s = await open()
    const unowned = asMachineId('machine-access-unowned')
    await s.machines.upsertMachine({
      id: unowned,
      name: unowned,
      hostname: unowned,
      tokenHash: 'test',
      ownerUserId: null,
      assignment: { server: false, agentExecution: true },
    })
    expect(await s.machines.custodian(unowned)).toBeNull()
    const none = { harness: 'claude-code' as const, actingUserId: OWNER, machineId: unowned }
    expect(await resolveSessionAccess(s, { ...none, credentialId: null })).toMatchObject({
      ok: false,
      refusal: 'own-credential-required',
    })
    const id = await vaultCredential(s, 'anthropic.api-key')
    expect(await resolveSessionAccess(s, { ...none, credentialId: id })).toMatchObject({
      ok: false,
      refusal: 'machine-not-allowed',
    })
    await s.credentials.allowMachine(id, unowned, OWNER)
    expect(await resolveSessionAccess(s, { ...none, credentialId: id })).toMatchObject({
      ok: true,
      credentialId: id,
    })
  })
})

describe('resolveInferenceAccess', () => {
  it('returns the declared route and never the secret', async () => {
    const s = await open()
    const id = await vaultCredential(s, 'openrouter.api-key')
    const result = await resolveInferenceAccess(s, { credentialId: id, actingUserId: OWNER })
    expect(result).toEqual({
      ok: true,
      credentialId: id,
      route: { kind: 'http', api: 'openai-chat', base: 'openrouter' },
    })
    expect(JSON.stringify(result)).not.toContain(PLANTED)
  })

  it('refuses a type no route serves, and another person’s credential', async () => {
    const s = await open()
    const token = await vaultCredential(s, 'anthropic.claude-token')
    expect(await resolveInferenceAccess(s, { credentialId: token, actingUserId: OWNER })).toEqual({
      ok: false,
      refusal: 'wrong-type',
      message: ACCESS_REFUSAL_MESSAGES['wrong-type'],
    })
    const theirs = await vaultCredential(s, 'openai.api-key', OTHER)
    expect(
      await resolveInferenceAccess(s, { credentialId: theirs, actingUserId: OWNER }),
    ).toMatchObject({
      ok: false,
      refusal: 'not-yours',
    })
  })
})

describe('ACCESS_REFUSAL_MESSAGES', () => {
  it('has the eleven sentences of the plan', () => {
    expect(ACCESS_REFUSAL_MESSAGES).toEqual({
      'not-found': 'This credential no longer exists.',
      'not-yours': 'You do not have use of this credential. Ask its owner to share it.',
      'wrong-type': 'This kind of credential cannot be used here.',
      'not-on-this-machine':
        'This login is not signed in on this machine. Sign in there, or pick another machine.',
      'machine-not-allowed': "This credential's owner has not sent it to this machine.",
      'own-credential-required':
        'The logins on this machine belong to the person who looks after it. Pick one of your own credentials.',
      'needs-attention':
        'This credential needs attention before it can be used. Renew it or pick another.',
      revoked: 'This credential was removed.',
      'daemon-too-old': 'Podium on this machine is too old to receive credentials. Update it.',
      'connection-not-encrypted':
        "This machine's connection to the server is not encrypted, so credentials are not sent to it. Connect it over wss or declare its network trusted.",
      'machine-offline':
        'This machine is not connected, so its credential cannot be sent. Try again when it is online.',
    })
  })

  it('cannot be written without one of them (compile check)', () => {
    // @ts-expect-error -- 'connection-not-encrypted' is missing, so this does not compile.
    const ten: Record<AccessRefusal, string> = {
      'not-found': '',
      'not-yours': '',
      'wrong-type': '',
      'not-on-this-machine': '',
      'machine-not-allowed': '',
      'own-credential-required': '',
      'needs-attention': '',
      revoked: '',
      'daemon-too-old': '',
      'machine-offline': '',
    }
    expect(Object.keys(ten)).toHaveLength(10)
  })
})
