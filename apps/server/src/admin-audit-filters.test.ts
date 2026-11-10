import { asUserId, firstAdminMemberId } from '@podium/model'
import { Hono } from 'hono'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { registerAdminRoutes, type SecurityEvent } from './admin-routes'
import type { SessionStore } from './store'
import { openTestStore } from './test-support/open-test-store'

const bob = asUserId('mem_audit_bob')
let alice: string
let store: SessionStore
let app: Hono
let caller: string
const ids = new Map<string, number>()
const fixtures = [
  { command: 'members.invite', person: 'alice', kind: 'people', refused: true },
  { command: 'machines.revoke', person: 'bob', kind: 'machines', refused: true },
  { command: 'settings.setSecret', person: 'alice', kind: 'credentials', refused: true },
  {
    command: 'issues.deleteComment',
    person: 'alice',
    kind: 'comments',
    refused: true,
    agent: true,
  },
  { command: 'members.setRole', person: 'bob', kind: 'people', refused: true },
  { command: 'takeover', person: 'alice', kind: 'machines', refused: false },
  { command: 'issues.editComment', person: 'alice', kind: 'comments', refused: false },
  { command: 'settings.clearSecret', person: 'bob', kind: 'credentials', refused: false },
  { command: 'accounts.unsend', person: 'bob', kind: 'credentials', refused: false },
  { command: 'members.disable', person: 'alice', kind: 'people', refused: true, agent: true },
  { command: 'machines.enrollSetup', person: 'system', kind: 'machines', refused: false },
  { command: 'members.remove', person: 'alice', kind: 'people', refused: true },
  // These look like security events but must never enter any filtered page.
  { command: 'settings.updatePreferences', person: 'alice', kind: null, refused: true },
  { command: 'membersXinvite', person: 'alice', kind: null, refused: true },
] as const

beforeAll(async () => {
  store = await openTestStore(':memory:')
  alice = firstAdminMemberId()
  caller = alice
  await store.users.create(
    {
      id: bob,
      displayName: 'Bob',
      role: 'member',
      createdAt: '2026-11-01T00:00:00Z',
      disabledAt: null,
    },
    'hash',
  )
  for (const row of fixtures) {
    const person = row.person === 'alice' ? alice : row.person === 'bob' ? bob : null
    const agent = 'agent' in row && row.agent
    await store.settingsAudit.append({
      command: row.command,
      outcome: row.refused ? 'refused' : 'applied',
      actorKind: agent ? 'agent' : person ? 'user' : 'system',
      actorId: agent ? 'session:audit-agent' : (person ?? 'system:setup'),
      onBehalfOf: person,
      detail: { input: { key: 'apiKeys.test', value: 'never-send-this' }, text: 'private comment' },
      redactedPaths: [],
      createdAt: '2026-11-09T12:00:00Z',
    })
  }
  for (const row of await store.settingsAudit.securityEvents(100)) ids.set(row.command, row.id)
  app = new Hono()
  registerAdminRoutes(app, {
    users: store.users,
    auth: store.auth,
    audit: store.settingsAudit,
    machineNames: async () => new Map(),
    resolveUserId: async () => asUserId(caller),
    loginRequired: async () => true,
  })
})
afterAll(async () => await store?.close())

async function page(query: URLSearchParams) {
  const response = await app.request(`http://podium.test/auth/admin/audit?${query}`)
  expect(response.status).toBe(200)
  const body = (await response.json()) as { events: SecurityEvent[]; nextBefore: number | null }
  expect(JSON.stringify(body)).not.toContain('never-send-this')
  expect(JSON.stringify(body)).not.toContain('private comment')
  return body
}

describe('security event filters run before the page limit', () => {
  for (const person of [undefined, 'alice', 'bob'] as const) {
    for (const kind of [undefined, 'people', 'machines', 'credentials', 'comments'] as const) {
      for (const refusedOnly of [false, true]) {
        it(`pages actor=${person ?? 'anyone'} kind=${kind ?? 'all'} refusedOnly=${refusedOnly}`, async () => {
          const query = new URLSearchParams({ limit: '2', refusedOnly: String(refusedOnly) })
          if (person) query.set('actor', person === 'alice' ? alice : bob)
          if (kind) query.set('kind', kind)
          const expected = [...fixtures]
            .reverse()
            .filter(
              (row) =>
                row.kind !== null &&
                (!person || row.person === person) &&
                (!kind || row.kind === kind) &&
                (!refusedOnly || row.refused),
            )
          const seen: number[] = []
          for (let offset = 0; offset <= expected.length; offset += 2) {
            const body = await page(query)
            const expectedIds = expected
              .slice(offset, offset + 2)
              .map((row) => ids.get(row.command))
            expect(body.events.map((row) => row.id)).toEqual(expectedIds)
            seen.push(...body.events.map((row) => row.id))
            expect(body.nextBefore).toBe(expectedIds.length === 2 ? expectedIds[1] : null)
            if (body.nextBefore === null) break
            query.set('before', String(body.nextBefore))
          }
          expect(seen).toHaveLength(expected.length)
          expect(new Set(seen).size).toBe(seen.length)
        })
      }
    }
  }

  it('returns an empty page for an unknown person', async () => {
    expect(await page(new URLSearchParams({ actor: 'mem_unknown' }))).toEqual({
      events: [],
      nextBefore: null,
    })
  })

  it.each([
    'kind=unknown',
    'kind=',
    'actor=',
    'refusedOnly=1',
    'refusedOnly=no',
  ])('rejects invalid filters: %s', async (query) => {
    expect((await app.request(`http://podium.test/auth/admin/audit?${query}`)).status).toBe(400)
  })

  it('still refuses a non-admin using filters', async () => {
    caller = bob
    try {
      expect(
        (
          await app.request(
            `http://podium.test/auth/admin/audit?actor=${alice}&kind=comments&refusedOnly=true`,
          )
        ).status,
      ).toBe(403)
    } finally {
      caller = alice
    }
  })
})
