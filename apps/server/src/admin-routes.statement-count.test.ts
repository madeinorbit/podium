/**
 * THE ADMIN AREA'S READS RUN A FIXED NUMBER OF STATEMENTS (POD-6299,
 * server-data rule 8), whatever the number of members, sign-ins, invites,
 * machines and audit rows: Access and Audit each read every table they need
 * once, and the People list names each member's allowed actions from one read
 * of who has a password.
 */
import { asInviteId, asMachineId, asUserId, firstAdminMemberId } from '@podium/model'
import { Hono } from 'hono'
import { describe, expect, it, vi } from 'vitest'
import { registerAdminRoutes } from './admin-routes'
import { MemberInvites } from './member-invites'
import { registerMemberRoutes } from './member-routes'
import type { SessionStore } from './store'
import { openTestStore } from './test-support/open-test-store'
import {
  expectArmed,
  expectConstantStatements,
  type StatementPin,
} from './test-support/statement-count'

const at = '2026-11-04T12:00:00.000Z'
const future = '2999-01-01T00:00:00.000Z'

interface Fixture {
  store: SessionStore
  app: Hono
}

async function setup(size: number): Promise<Fixture> {
  const store = await openTestStore(':memory:')
  const admin = firstAdminMemberId()
  for (let i = 0; i < size; i++) {
    const id = asUserId(`mem_pin_${i}`)
    await store.users.create(
      { id, displayName: `Member ${i}`, role: 'member', createdAt: at, disabledAt: null },
      'hash',
    )
    await store.auth.createClientSession(`pin-cookie-${i}`, id, future)
    await store.users.insertInvite({
      id: asInviteId(`invite-pin-${i}`),
      tokenHash: `invite-hash-${i}`,
      memberId: null,
      role: 'member',
      expiresAt: future,
      createdBy: admin,
      createdAt: at,
    })
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
    auth: store.auth,
    audit: store.settingsAudit,
    machineNames: async (ids) =>
      new Map([...(await store.machines.getMachines(ids))].map(([id, m]) => [id, m.name])),
    resolveUserId,
    loginRequired: async () => true,
  })
  registerMemberRoutes(app, {
    users: store.users,
    invites: new MemberInvites(store.users),
    resolveUserId,
    appUrl: () => 'http://podium.test',
  })
  return { store, app }
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
    const rows = body.signIns ?? body.events ?? body.members
    expect(rows!.length).toBeGreaterThanOrEqual(size)
  },
  teardown: async (fixture) => await fixture.store.close(),
})

describe('admin area reads', () => {
  it('Access runs a constant number of statements', async () => {
    await expectConstantStatements(pin('/auth/admin/access'), 5)
  })
  it('ending one sign-in runs a constant number of statements (POD-6701)', async () => {
    await expectConstantStatements(
      {
        name: 'POST /auth/admin/sign-ins/revoke',
        setup,
        target: (fixture) => fixture.store,
        run: async (fixture) => {
          const [first] = await fixture.store.auth.listUnexpiredSignIns(at, 1)
          const id = first!.sessionId!
          const response = await fixture.app.request(
            'http://podium.test/auth/admin/sign-ins/revoke',
            {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({ id }),
            },
          )
          return { status: response.status, id }
        },
        check: async (result, fixture, size) => {
          const { status, id } = result as { status: number; id: string }
          expect(status).toBe(200)
          const left = await fixture.store.auth.listUnexpiredSignIns(at, 1000)
          expect(left.map((row) => row.sessionId)).not.toContain(id)
          expect(left.length).toBe(size - 1)
        },
        teardown: async (fixture) => await fixture.store.close(),
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
    await expectConstantStatements(pin('/auth/members/list'), 5)
  })
})
