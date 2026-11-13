/**
 * The on-machine route (POD-4750, credential management §9): a direct call on
 * a ChatGPT login runs on the machine whose Codex home holds that login, and
 * only the answer comes back. Since credentials, the login is chosen by the
 * credential (its fingerprint), not by "any Codex login on the fleet".
 */

import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { bundledDescriptorFor } from '@podium/harness/browser'
import {
  asMachineId,
  asUserId,
  type CredentialId,
  Inventory,
  type MachineId,
  type UserId,
} from '@podium/model'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { CodexLoginMachineSource, CodexTurnResult } from './codex-machine'
import { LlmConfigError } from './llm'
import { complete, type OnMachineTransport } from './modules/inference/complete'
import type { SessionStore } from './store'
import { openTestStore } from './test-support/open-test-store'

const OWNER = asUserId('user:codex-owner')
const OTHER = asUserId('user:codex-other')
const NOW = '2026-11-13T00:00:00.000Z'

function inventoryFor(state: 'in' | 'out', fingerprint?: string) {
  return Inventory.parse({
    os: 'linux',
    arch: 'x64',
    agents: [
      {
        kind: 'codex',
        installed: true,
        login: { state, ...(fingerprint ? { identity: { fingerprint } } : {}) },
      },
    ],
  })
}

function record(
  id: string,
  opts: { login?: 'in' | 'out'; fingerprint?: string; appVersion?: string | null } = {},
): CodexLoginMachineSource {
  return {
    id: asMachineId(id),
    name: id,
    revokedAt: null,
    inventory: inventoryFor(opts.login ?? 'in', opts.fingerprint ?? 'fp-mine'),
    appVersion: opts.appVersion ?? null,
  }
}

let store: SessionStore | undefined
afterEach(async () => {
  await store?.close()
  store = undefined
})

/** A store whose machines exist, each looked after by `custodians[id]` (default OWNER). */
async function openWith(
  records: CodexLoginMachineSource[],
  custodians: Record<string, UserId> = {},
): Promise<SessionStore> {
  store = await openTestStore(':memory:')
  for (const r of records) {
    await store.machines.upsertMachine({
      id: r.id,
      name: r.name,
      hostname: r.name,
      tokenHash: 'test',
      ownerUserId: custodians[String(r.id)] ?? OWNER,
      assignment: { server: false, agentExecution: true },
    })
  }
  return store
}

async function chatgptLogin(
  s: SessionStore,
  fingerprint = 'fp-mine',
  owner: UserId = OWNER,
): Promise<CredentialId> {
  const credential = await s.credentials.insert({
    ownerUserId: owner,
    label: 'ChatGPT login',
    type: 'openai.chatgpt-login',
    identity: { fingerprint },
  })
  return credential.id
}

interface Stub {
  records: CodexLoginMachineSource[]
  online: string[]
  defaultId?: string
  complete?: (input: { model: string; effort: string }) => Promise<CodexTurnResult>
}

function stubTransport(stub: Stub) {
  const calls: { machineId: string; model: string; effort: string }[] = []
  const transport: OnMachineTransport = {
    listMachines: async () => stub.records,
    isOnline: (id: MachineId) => stub.online.includes(String(id)),
    defaultMachineId: async () => (stub.defaultId ? asMachineId(stub.defaultId) : undefined),
    codexComplete: async (machineId, input) => {
      calls.push({ machineId: String(machineId), model: input.model, effort: input.effort })
      return await (stub.complete ?? (async () => ({ ok: true, text: 'ok', toolCalls: [] })))(input)
    },
  }
  return { transport, calls }
}

const hi = [{ role: 'user' as const, content: 'hi' }]

describe('on-machine route: the login chosen by credential (POD-4750)', () => {
  let prevCodexHome: string | undefined
  let emptyHome: string

  beforeEach(() => {
    // The server's own home has NO Codex login: any file read here fails the
    // proof — the turn must succeed off the machine that holds the login.
    prevCodexHome = process.env.CODEX_HOME
    emptyHome = mkdtempSync(join(tmpdir(), 'codex-server-home-'))
    process.env.CODEX_HOME = emptyHome
  })
  afterEach(() => {
    if (prevCodexHome === undefined) delete process.env.CODEX_HOME
    else process.env.CODEX_HOME = prevCodexHome
  })

  it('a turn runs on the machine holding the chosen login, with no server-side login file', async () => {
    const records = [
      // A skewed daemon version must not stop the call: version skew never gates the pick.
      record('desk', { appVersion: 'v0.0.1-ancient' }),
      record('laptop', { fingerprint: 'fp-someone-else' }),
    ]
    const s = await openWith(records)
    const id = await chatgptLogin(s)
    const { transport, calls } = stubTransport({
      records,
      online: ['desk', 'laptop'],
      defaultId: 'laptop',
      complete: async () => ({ ok: true, text: 'hello from the daemon', toolCalls: [] }),
    })
    const result = await complete(
      { store: s, onMachine: transport },
      { credentialId: id, model: 'gpt-5.5', messages: hi, actingUserId: OWNER },
    )
    expect(result).toEqual({
      text: 'hello from the daemon',
      toolCalls: [],
      servedBy: id,
      label: 'ChatGPT login',
    })
    // The default machine holds another login, so it is not the one picked.
    expect(calls).toEqual([{ machineId: 'desk', model: 'gpt-5.5', effort: 'medium' }])
  })

  it('of two machines holding the login, the online default is picked', async () => {
    const records = [record('a-box'), record('z-box')]
    const s = await openWith(records)
    const id = await chatgptLogin(s)
    const { transport, calls } = stubTransport({
      records,
      online: ['a-box', 'z-box'],
      defaultId: 'z-box',
    })
    await complete(
      { store: s, onMachine: transport },
      { credentialId: id, model: 'm', messages: hi, actingUserId: OWNER },
    )
    expect(calls.map((c) => c.machineId)).toEqual(['z-box'])
  })

  it("'auto' resolves from the harness catalog, and the role's effort rides through (POD-4805)", async () => {
    const records = [record('desk')]
    const s = await openWith(records)
    const id = await chatgptLogin(s)
    await s.settings.applyPreferencePatch(
      OWNER,
      {
        'roles.background.credentialId': id,
        'roles.background.model': 'auto',
        'roles.background.effort': 'high',
      },
      NOW,
    )
    const { transport, calls } = stubTransport({ records, online: ['desk'] })
    const head = bundledDescriptorFor('codex')?.catalog.models[0]?.value
    expect(head).toBeTruthy()
    await complete(
      { store: s, onMachine: transport },
      { role: 'background', messages: hi, actingUserId: OWNER },
    )
    await complete(
      { store: s, onMachine: transport },
      { credentialId: id, model: 'gpt-5.5', messages: hi, actingUserId: OWNER },
    )
    expect(calls).toEqual([
      { machineId: 'desk', model: head, effort: 'high' },
      { machineId: 'desk', model: 'gpt-5.5', effort: 'medium' },
    ])
  })

  it('a daemon refusal surfaces as LlmConfigError with the daemon text', async () => {
    const records = [record('desk')]
    const s = await openWith(records)
    const id = await chatgptLogin(s)
    const { transport } = stubTransport({
      records,
      online: ['desk'],
      complete: async () => ({
        ok: false,
        error: "Codex access token is expired and Podium won't refresh it",
      }),
    })
    const call = complete(
      { store: s, onMachine: transport },
      { credentialId: id, model: 'm', messages: hi, actingUserId: OWNER },
    )
    await expect(call).rejects.toThrow(LlmConfigError)
    await expect(call).rejects.toThrow(/won't refresh/)
  })

  it('the machine holding the login is offline: the error names it', async () => {
    const records = [record('desk')]
    const s = await openWith(records)
    const id = await chatgptLogin(s)
    const { transport, calls } = stubTransport({ records, online: [] })
    await expect(
      complete(
        { store: s, onMachine: transport },
        { credentialId: id, model: 'm', messages: hi, actingUserId: OWNER },
      ),
    ).rejects.toThrow(/ChatGPT login on desk is offline/)
    expect(calls).toEqual([])
  })

  it('no machine holds the login: not signed in, and no other login is spent', async () => {
    const records = [record('desk', { fingerprint: 'fp-other' })]
    const s = await openWith(records)
    const id = await chatgptLogin(s)
    const { transport, calls } = stubTransport({ records, online: ['desk'] })
    await expect(
      complete(
        { store: s, onMachine: transport },
        { credentialId: id, model: 'm', messages: hi, actingUserId: OWNER },
      ),
    ).rejects.toThrow(/not signed in on a machine/)
    expect(calls).toEqual([])
  })

  it('a machine someone else looks after is used only once the owner sent the credential there', async () => {
    const records = [record('their-box')]
    const s = await openWith(records, { 'their-box': OTHER })
    const id = await chatgptLogin(s)
    const { transport, calls } = stubTransport({ records, online: ['their-box'] })
    const err = await complete(
      { store: s, onMachine: transport },
      { credentialId: id, model: 'm', messages: hi, actingUserId: OWNER },
    ).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(LlmConfigError)
    // Names neither the other person's machine nor spends its login.
    expect(String((err as Error).message)).not.toContain('their-box')
    expect(calls).toEqual([])
    await s.credentials.allowMachine(id, asMachineId('their-box'), OWNER)
    await complete(
      { store: s, onMachine: transport },
      { credentialId: id, model: 'm', messages: hi, actingUserId: OWNER },
    )
    expect(calls.map((c) => c.machineId)).toEqual(['their-box'])
  })

  it('without a transport the route fails closed (never a local file read)', async () => {
    const s = await openWith([])
    const id = await chatgptLogin(s)
    await expect(
      complete({ store: s }, { credentialId: id, model: 'm', messages: hi, actingUserId: OWNER }),
    ).rejects.toThrow(LlmConfigError)
  })

  it("an old background role of 'native:codex' reads as the login on the person's own machine", async () => {
    const records = [record('their-box', { fingerprint: 'fp-theirs' }), record('desk')]
    const s = await openWith(records, { 'their-box': OTHER })
    const mine = await chatgptLogin(s)
    await chatgptLogin(s, 'fp-theirs', OTHER)
    await s.settings.applyPreferencePatch(
      OWNER,
      { 'roles.background.accountId': 'native:codex', 'roles.background.model': 'gpt-5.5' },
      NOW,
    )
    const { transport, calls } = stubTransport({
      records,
      online: ['their-box', 'desk'],
      defaultId: 'their-box',
    })
    const result = await complete(
      { store: s, onMachine: transport },
      { role: 'background', messages: hi, actingUserId: OWNER },
    )
    expect(result.servedBy).toBe(mine)
    expect(calls.map((c) => c.machineId)).toEqual(['desk'])
  })
})
