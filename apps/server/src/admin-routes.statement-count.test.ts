/**
 * THE ADMIN AREA'S READS RUN A FIXED NUMBER OF STATEMENTS (POD-6299,
 * server-data rule 8), whatever the number of members, sign-ins, invites,
 * machines and audit rows: Access and Audit each read every table they need
 * once, and the People list names each member's allowed actions from one read
 * of who has a password.
 */
import { asMachineId, asUserId, firstAdminMemberId } from '@podium/model'
import { Hono } from 'hono'
import { describe, expect, it, vi } from 'vitest'
import { registerAdminRoutes } from './admin-routes'
import { registerMemberRoutes } from './member-routes'
import { registerSignInRoutes } from './sign-in-routes'
import type { SessionStore } from './store'
import { openTestStore } from './test-support/open-test-store'
import {
  expectArmed,
  expectConstantStatements,
  type StatementPin,
} from './test-support/statement-count'
import { cookieOf, openTestIdentity } from './test-support/test-identity'

const at = '2026-11-04T12:00:00.000Z'

interface Fixture {
  store: SessionStore
  app: Hono
  adminCookie: string
  targetSignIn: string
}

async function setup(size: number): Promise<Fixture> {
  const store = await openTestStore(':memory:')
  const admin = firstAdminMemberId()
  const identity = await openTestIdentity(store)
  const { workspace } = identity
  const adminAccount = (await store.users.get(admin))?.accountId
  if (!adminAccount) throw new Error('Missing admin account')
  const adminCookie = cookieOf(
    await workspace.core.deviceSignIns.create(adminAccount, { kind: 'browser' }, 'cookie', {
      scheme: 'https',
      sameMachine: false,
      clientAddress: null,
    }),
  )
  let targetSignIn = ''
  for (let i = 0; i < size; i++) {
    const id = await identity.addMember({ name: `Member ${i}`, email: `member-${i}@example.com` })
    const member = await store.users.get(id)
    const signIn = await identity.workspace.core.deviceSignIns.create(
      member!.accountId!,
      { kind: 'browser' },
      'cookie',
      { scheme: 'https', sameMachine: false, clientAddress: null },
    )
    if (!targetSignIn) targetSignIn = signIn.deviceSignInId
    await identity.workspace.memberships.invite({ actor: { memberId: admin }, role: 'member' })
    const machineId = asMachineId(`machine-pin-${i}`)
    await store.machines.upsertMachine({
      id: machineId,
      ownerUserId: null,
      name: machineId,
      hostname: machineId,
      tokenHash: machineId,
    })
    await store.settingsAudit.append({
      command: 'takeover',
      outcome: 'applied',
      actorKind: 'user',
      actorId: admin,
      onBehalfOf: admin,
      detail: { machineId, previousOwnerUserId: null, newOwnerUserId: admin },
      redactedPaths: [],
      createdAt: at,
    })
    await store.settingsAudit.append({
      command: 'machines.revoke',
      outcome: 'refused',
      actorKind: 'agent',
      actorId: `session:pin-${i}`,
      onBehalfOf: admin,
      detail: { machineId },
      redactedPaths: [],
      createdAt: at,
    })
    await store.users.audit('members.setRole', admin, { memberId: id, from: 'member', to: 'admin' })
  }
  const app = new Hono()
  const resolveUserId = async () => admin
  registerAdminRoutes(app, {
    users: store.users,
    settings: store.settings,
    sessions: store.sessions,
    identity: identity.workspace,
    audit: store.settingsAudit,
    machineNames: async (ids) =>
      new Map([...(await store.machines.getMachines(ids))].map(([id, m]) => [id, m.name])),
    resolveUserId,
    loginRequired: async () => true,
  })
  registerMemberRoutes(app, {
    users: store.users,
    identity: identity.workspace,
    resolveUserId,
    appUrl: () => 'http://podium.test',
  })
  registerSignInRoutes(app, {
    identity: workspace,
    memberOfRequest: identity.memberOfRequest,
    audit: store.settingsAudit,
  })
  // First touch of a device records last-seen; subsequent requests reuse it.
  await identity.memberOfRequest(
    new Request('https://podium.test', { headers: { cookie: adminCookie } }),
  )
  return { store, app, adminCookie, targetSignIn }
}

const pin = (path: string | (() => string)): StatementPin<Fixture> => ({
  name: `GET ${path}`,
  setup,
  target: (fixture) => fixture.store,
  run: async (fixture) => {
    const response = await fixture.app.request(
      `http://podium.test${typeof path === 'string' ? path : path()}`,
    )
    return { status: response.status, body: await response.json() }
  },
  check: (result, _fixture, size) => {
    const { status, body } = result as { status: number; body: Record<string, unknown[]> }
    expect(status).toBe(200)
    if (body.admission)
      expect((body.admission as unknown as { activeMembers: number }).activeMembers).toBe(size + 1)
    else expect((body.events ?? body.members)!.length).toBeGreaterThanOrEqual(size)
  },
  teardown: async (fixture) => await fixture.store.close(),
})

describe('admin area reads', () => {
  it('Access runs a constant number of statements', async () => {
    await expectConstantStatements(pin('/auth/admin/access'), 4)
  })
  it('lists and counts sign-ins in a fixed number of statements', async () => {
    await expectConstantStatements(
      {
        name: 'GET /auth/admin/sign-ins',
        setup,
        target: (fixture) => fixture.store,
        run: async ({ app, adminCookie }) => {
          const response = await app.request('https://podium.test/auth/admin/sign-ins', {
            headers: { cookie: adminCookie },
          })
          return { status: response.status, ...(await response.json()) }
        },
        check: (result, _fixture, size) => {
          expect(result).toMatchObject({ status: 200, signInsTotal: size + 1 })
        },
        teardown: (fixture) => fixture.store.close(),
      },
      4,
    )
  })
  it('ending one sign-in through the admin route runs a constant number of statements', async () => {
    await expectConstantStatements(
      {
        name: 'POST /auth/admin/sign-ins/revoke',
        setup,
        target: (fixture) => fixture.store,
        run: async ({ app, adminCookie, targetSignIn }) => {
          const response = await app.request('https://podium.test/auth/admin/sign-ins/revoke', {
            method: 'POST',
            headers: { cookie: adminCookie, 'content-type': 'application/json' },
            body: JSON.stringify({ id: targetSignIn }),
          })
          return { status: response.status, ...(await response.json()) }
        },
        check: async (result, { app, adminCookie, targetSignIn }, size) => {
          expect(result).toEqual({ status: 200, ok: true })
          const response = await app.request('https://podium.test/auth/admin/sign-ins', {
            headers: { cookie: adminCookie },
          })
          const { signIns, signInsTotal } = await response.json()
          expect(signIns.map((row: { id: string }) => row.id)).not.toContain(targetSignIn)
          expect(signInsTotal).toBe(size)
        },
        teardown: (fixture) => fixture.store.close(),
      },
      6,
    )
  })
  it('Audit runs a constant number of statements', async () => {
    await expectConstantStatements(pin('/auth/admin/audit?limit=200'), 4)
  })
  it('filtered Audit stays at four statements and its pin catches a per-event read', async () => {
    const filtered = pin(
      () =>
        `/auth/admin/audit?limit=200&actor=${firstAdminMemberId()}&kind=machines&refusedOnly=true`,
    )
    await expectConstantStatements(filtered, 4)
    await expectArmed(filtered, 4, (fixture) => {
      const audit = fixture.store.settingsAudit
      const original = audit.securityEvents.bind(audit)
      const spy = vi.spyOn(audit, 'securityEvents').mockImplementation(async (...args) => {
        const rows = await original(...args)
        for (const row of rows) {
          if (row.onBehalfOf) await fixture.store.users.get(asUserId(row.onBehalfOf))
        }
        return rows
      })
      return () => spy.mockRestore()
    })
  })
  it('the member directory runs a constant number of statements', async () => {
    const directory = pin('/auth/members/directory')
    await expectConstantStatements(directory, 3)
    await expectArmed(directory, 3, ({ store }) => {
      const list = store.users.list.bind(store.users)
      const spy = vi.spyOn(store.users, 'list').mockImplementation(async () => {
        const members = await list()
        for (const member of members) await store.users.get(asUserId(member.id))
        return members
      })
      return () => spy.mockRestore()
    })
  })
  it('the People list runs a constant number of statements', async () => {
    await expectConstantStatements(pin('/auth/members/list'), 7)
  })
})
