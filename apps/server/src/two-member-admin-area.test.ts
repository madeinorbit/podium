/**
 * THE ADMINISTRATION AREA, WITH TWO MEMBERS (POD-6299; design §2.6).
 *
 * Through the production HTTP routes with each member's own login cookie:
 *
 * - Alice, an admin, is offered every section (People, Access, Machines,
 *   Instance, Audit) and can read and use each. Bob, a member, is offered none,
 *   and each admin endpoint refuses him.
 * - People carries the server's allowed actions per member.
 * - Access lists how people are admitted and every unexpired sign-in, without
 *   a token or its hash.
 * - Adopting an unowned machine the way the admin area does (`machines.adopt`
 *   with no recipient) writes a takeover event, and the Audit section shows it.
 * - Audit shows member, role, admission and custody events as actor, delegated
 *   human, target, result and time, and never a secret's value, an invite
 *   token, an email, a preference value or any session text.
 */

import { asMachineId } from '@podium/model'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { projectSecurityEvent } from './admin-routes'
import { sha256 } from './modules/machines/enrollment'
import {
  MEMBERS,
  type MemberName,
  startTwoMemberInstance,
  type TwoMemberInstance,
} from './test-support/two-member-instance'

let f: TwoMemberInstance
/** Alice's stored display name (the fixture's first admin is the install's operator). */
let aliceName: string
const ORPHAN = asMachineId('machine-admin-orphan')
const SECRET_VALUE = 'sk-or-admin-area-secret-value-0123456789'
const PREFERENCE_VALUE = 'admin-area-preference-marker'

type Json = Record<string, unknown>

async function get(who: MemberName | null, path: string): Promise<{ status: number; body: Json }> {
  const response = who ? await (await f.as(who)).fetch(path) : await fetch(new URL(path, f.origin))
  return { status: response.status, body: (await response.json().catch(() => ({}))) as Json }
}

async function post(who: MemberName, path: string, body: unknown) {
  const response = await (await f.as(who)).fetch(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
  return { status: response.status, body: (await response.json().catch(() => ({}))) as Json }
}

beforeAll(async () => {
  f = await startTwoMemberInstance()
  await f.handle.registry.sessionStore.machines.upsertMachine({
    id: ORPHAN,
    name: 'Spare build box',
    hostname: ORPHAN,
    tokenHash: sha256(`${ORPHAN}-token`),
    ownerUserId: null,
    assignment: { server: false, agentExecution: true },
  })
  aliceName = (await f.handle.registry.sessionStore.users.get(MEMBERS.alice.id))!.displayName
  await f.as('alice')
  await f.as('bob')
}, 60_000)
afterAll(async () => {
  await f?.close()
})

describe('who is offered the admin area', () => {
  it('Alice is offered every section; Bob none', async () => {
    expect(await get('alice', '/auth/admin/viewer')).toEqual({
      status: 200,
      body: { sections: ['people', 'access', 'machines', 'instance', 'audit'] },
    })
    expect(await get('bob', '/auth/admin/viewer')).toEqual({ status: 200, body: { sections: [] } })
    expect((await get(null, '/auth/admin/viewer')).status).toBe(401)
  })

  it('Bob’s requests to the admin endpoints are refused', async () => {
    for (const path of ['/auth/admin/access', '/auth/admin/audit', '/auth/members/list']) {
      const answer = await get('bob', path)
      expect(answer.status, path).toBe(403)
      expect(JSON.stringify(answer.body)).not.toContain(MEMBERS.alice.email)
    }
    for (const [path, body] of [
      [
        '/auth/members/role',
        { id: MEMBERS.alice.id, role: 'member', current: MEMBERS.bob.password },
      ],
      ['/auth/members/disable', { id: MEMBERS.alice.id, current: MEMBERS.bob.password }],
      ['/auth/members/invite', { role: 'member' }],
      ['/auth/members/sign-out-everywhere', { id: MEMBERS.alice.id }],
    ] as const) {
      expect((await post('bob', path, body)).status, path).toBe(403)
    }
    const bob = (await f.as('bob')).trpc
    await expect(bob.machines.adopt.mutate({ id: ORPHAN })).rejects.toThrow()
    expect(await f.handle.registry.sessionStore.machines.custodian(ORPHAN)).toBeNull()
    await expect(
      bob.settings.setSecret.mutate({ key: 'apiKeys.openrouter', value: SECRET_VALUE }),
    ).rejects.toThrow()
  })
})

describe('People: the allowed actions come from the server', () => {
  it('names what Alice may do to each member', async () => {
    const { status, body } = await get('alice', '/auth/members/list')
    expect(status).toBe(200)
    expect(body.actions).toEqual({
      [MEMBERS.alice.id]: ['signOutEverywhere'],
      [MEMBERS.bob.id]: ['setRole', 'disable', 'remove', 'recovery', 'signOutEverywhere'],
      [MEMBERS.carol.id]: ['enable', 'remove'],
    })
  })
})

describe('Access: admission and sign-ins', () => {
  it('shows invitation-only admission and each member’s sign-ins, never a token hash', async () => {
    const { status, body } = await get('alice', '/auth/admin/access')
    expect(status).toBe(200)
    expect(body.admission).toEqual(
      expect.objectContaining({ mode: 'invitation', signInRequired: true, activeMembers: 2 }),
    )
    const signIns = body.signIns as { memberId: string; memberName: string; kind: string }[]
    expect(signIns).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          memberId: MEMBERS.alice.id,
          memberName: aliceName,
          kind: 'login',
        }),
        expect.objectContaining({ memberId: MEMBERS.bob.id, memberName: 'Bob', kind: 'login' }),
      ]),
    )
    const text = JSON.stringify(body)
    const auth = f.handle.registry.sessionStore.auth
    for (const member of [MEMBERS.alice, MEMBERS.bob]) {
      for (const row of await auth.listClientSessionsOfUser(member.id)) {
        expect(text).not.toContain(row.tokenHash)
      }
    }
    expect(text).not.toContain('tokenHash')
  })
})

describe('Machines and Audit', () => {
  it('adopting an unowned machine from the admin area writes a takeover the audit view shows', async () => {
    const alice = (await f.as('alice')).trpc
    // The admin area's Adopt button names no recipient: the admin takes custody.
    await alice.machines.adopt.mutate({ id: ORPHAN })
    expect(await f.handle.registry.sessionStore.machines.custodian(ORPHAN)).toBe(MEMBERS.alice.id)
    const { status, body } = await get('alice', '/auth/admin/audit')
    expect(status).toBe(200)
    expect(body.events).toContainEqual(
      expect.objectContaining({
        command: 'takeover',
        result: 'applied',
        actor: { kind: 'member', id: MEMBERS.alice.id, name: aliceName },
        onBehalfOf: { kind: 'member', id: MEMBERS.alice.id, name: aliceName },
        target: { kind: 'machine', id: ORPHAN, name: 'Spare build box' },
        facts: { previousOwner: 'Nobody', newOwner: aliceName },
        at: expect.any(String),
      }),
    )
  })

  it('Alice sees Bob taking a key back from a machine, including in Credentials', async () => {
    const alice = (await f.as('alice')).trpc
    const bob = (await f.as('bob')).trpc
    const credential = 'sk-ant-admin-audit-bob-11111111111111'
    const send = { id: 'managed:anthropic', machineId: f.machines.alice }
    await alice.machines.share.mutate({
      id: f.machines.alice,
      grantee: MEMBERS.bob.id,
      verb: 'use',
      acknowledgeSharedMachine: true,
    })
    await bob.accounts.connect.mutate({ provider: 'anthropic', kind: 'api-key', credential })
    await bob.accounts.send.mutate({ ...send, acknowledgeSharedMachine: true })
    expect(await bob.accounts.unsend.mutate(send)).toMatchObject({ ok: true, removed: true })

    for (const query of ['', '?kind=credentials', `?kind=credentials&actor=${MEMBERS.bob.id}`]) {
      const { status, body } = await get('alice', `/auth/admin/audit${query}`)
      expect(status).toBe(200)
      expect(body.events).toContainEqual(
        expect.objectContaining({
          command: 'accounts.unsend',
          result: 'applied',
          actor: { kind: 'member', id: MEMBERS.bob.id, name: 'Bob' },
          onBehalfOf: { kind: 'member', id: MEMBERS.bob.id, name: 'Bob' },
          target: { kind: 'machine', id: f.machines.alice, name: f.machines.alice },
          facts: {},
          at: expect.any(String),
        }),
      )
      expect(JSON.stringify(body)).not.toContain(credential)
    }
  })

  it('shows member, role and admission events and never secrets, tokens, emails or preference values', async () => {
    const alice = await f.as('alice')
    const invited = await post('alice', '/auth/members/invite', {
      email: 'dana@example.com',
      role: 'member',
    })
    expect(invited.status).toBe(200)
    const invite = invited.body.invite as { id: string; token: string }
    expect((await post('alice', '/auth/members/revoke', { id: invite.id })).status).toBe(200)
    const role = { id: MEMBERS.bob.id, current: MEMBERS.alice.password }
    expect((await post('alice', '/auth/members/role', { ...role, role: 'admin' })).status).toBe(200)
    expect((await post('alice', '/auth/members/role', { ...role, role: 'member' })).status).toBe(
      200,
    )
    // A refusal is an event too: Alice may not demote herself.
    expect(
      (
        await post('alice', '/auth/members/role', {
          id: MEMBERS.alice.id,
          current: MEMBERS.alice.password,
          role: 'member',
        })
      ).status,
    ).toBe(409)
    await alice.trpc.settings.setSecret.mutate({ key: 'apiKeys.openrouter', value: SECRET_VALUE })
    // A preference write is audited too, with its value; it is not a security event.
    // The instance settings are a synced record (POD-6677): a generic edit.
    await (
      alice.trpc as unknown as { sync: { submit: { mutate(input: unknown): Promise<unknown> } } }
    ).sync.submit.mutate({
      mutationId: 'alice-instance-branch',
      command: 'records.instancePreferences.edit',
      version: 1,
      input: { id: 'instance', patch: { 'gitWorkflow.defaultParentBranch': PREFERENCE_VALUE } },
    })
    expect(JSON.stringify(await f.handle.registry.sessionStore.settingsAudit.list(500))).toContain(
      PREFERENCE_VALUE,
    )

    const { body } = await get('alice', '/auth/admin/audit')
    const events = body.events as { command: string }[]
    const alicePair = {
      actor: { kind: 'member', id: MEMBERS.alice.id, name: aliceName },
      onBehalfOf: { kind: 'member', id: MEMBERS.alice.id, name: aliceName },
    }
    expect(events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          command: 'members.invite',
          ...alicePair,
          target: { kind: 'invite', id: invite.id, name: 'An invitation' },
          facts: { role: 'member' },
        }),
        expect.objectContaining({ command: 'members.inviteRevoked', ...alicePair }),
        expect.objectContaining({
          command: 'members.setRole',
          ...alicePair,
          target: { kind: 'member', id: MEMBERS.bob.id, name: 'Bob' },
          facts: { from: 'member', to: 'admin' },
        }),
        expect.objectContaining({
          command: 'members.disable',
          target: { kind: 'member', id: MEMBERS.carol.id, name: 'Carol' },
        }),
        expect.objectContaining({
          command: 'settings.setSecret',
          result: 'applied',
          ...alicePair,
          target: { kind: 'secret', id: null, name: 'apiKeys.openrouter' },
        }),
      ]),
    )
    // Newest first.
    const ids = (body.events as { id: number }[]).map((event) => event.id)
    expect(ids).toEqual([...ids].sort((a, b) => b - a))
    expect(events.some((event) => event.command.startsWith('settings.update'))).toBe(false)
    const text = JSON.stringify(body)
    for (const leak of [SECRET_VALUE, invite.token, '@example.com', PREFERENCE_VALUE]) {
      expect(text).not.toContain(leak)
    }
  })

  it('pages older events with the before cursor', async () => {
    const first = await get('alice', '/auth/admin/audit?limit=2')
    const events = first.body.events as { id: number }[]
    expect(events).toHaveLength(2)
    expect(first.body.nextBefore).toBe(events[1]!.id)
    const next = await get('alice', `/auth/admin/audit?limit=2&before=${events[1]!.id}`)
    for (const event of next.body.events as { id: number }[]) {
      expect(event.id).toBeLessThan(events[1]!.id)
    }
  })
})

describe('the audit projection reads only named fields', () => {
  it('drops everything else a stored row holds', () => {
    const projected = projectSecurityEvent(
      {
        id: 7,
        command: 'members.setRole',
        outcome: 'applied',
        actorKind: 'agent',
        actorId: 'session:abc',
        onBehalfOf: MEMBERS.alice.id,
        detail: {
          memberId: MEMBERS.bob.id,
          from: 'member',
          to: 'admin',
          transcript: 'the agent said something private',
          input: { value: 'raw-material' },
          email: 'bob@example.com',
        },
        redactedPaths: [],
        createdAt: '2026-11-04T00:00:00.000Z',
      },
      {
        members: new Map([
          [MEMBERS.alice.id, 'Alice'],
          [MEMBERS.bob.id, 'Bob'],
        ]),
        machines: new Map(),
      },
    )
    expect(projected).toEqual({
      id: 7,
      at: '2026-11-04T00:00:00.000Z',
      command: 'members.setRole',
      result: 'applied',
      actor: { kind: 'agent', id: 'session:abc', name: 'An agent' },
      onBehalfOf: { kind: 'member', id: MEMBERS.alice.id, name: 'Alice' },
      target: { kind: 'member', id: MEMBERS.bob.id, name: 'Bob' },
      facts: { from: 'member', to: 'admin' },
    })
  })
})
