import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { asSessionId, asUserId, type UserId } from '@podium/model'
import { fixtureWriteScope } from '@podium/sync/testing'
import { Hono } from 'hono'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { registerAdminRoutes } from './admin-routes'
import type { SessionStore } from './store'
import { openTestStore } from './test-support/open-test-store'
import {
  expectArmed,
  expectConstantStatements,
  type StatementPin,
} from './test-support/statement-count'
import { openTestIdentity } from './test-support/test-identity'

const stores: SessionStore[] = []
const directories: string[] = []
afterEach(async () => {
  for (const store of stores.splice(0).reverse()) await store.close()
  for (const path of directories.splice(0)) rmSync(path, { recursive: true, force: true })
})

async function fixture(path = ':memory:') {
  const store = await openTestStore(path)
  stores.push(store)
  const identity = await openTestIdentity(store)
  const firstAdmin = await store.users.earliestAdmin()
  if (!firstAdmin) throw new Error('Fixture has no installer')
  const admin = asUserId(firstAdmin.id)
  const app = new Hono()
  registerAdminRoutes(app, {
    users: store.users,
    settings: store.settings,
    sessions: store.sessions,
    identity: identity.workspace,
    audit: store.settingsAudit,
    machineNames: async () => new Map(),
    resolveUserId: async (request) => {
      const id = request.headers.get('test-member')
      return id ? asUserId(id) : undefined
    },
    loginRequired: async () => true,
  })
  const request = (path: string, member: UserId | null = admin, method = 'GET', origin?: string) =>
    app.request(`http://podium.test/auth/admin/${path}`, {
      method,
      headers: { ...(member ? { 'test-member': member } : {}), ...(origin ? { origin } : {}) },
    })
  const viewer = async () => (await request('viewer')).json()
  return { store, admin, identity, request, viewer }
}

async function seedSessions(f: Awaited<ReturnType<typeof fixture>>, size: number) {
  for (let i = 0; i < size; i++) {
    await f.store.sessions.upsertSession(fixtureWriteScope(), {
      id: asSessionId(`setup-session-${i}`),
      ownerUserId: f.admin,
      agentKind: 'codex',
      cwd: '/repo',
      title: 'Existing work',
      name: null,
      originKind: 'spawn',
      conversationId: null,
      resumeKind: null,
      resumeValue: null,
      status: 'exited',
      exitCode: 0,
      durableLabel: `setup-session-${i}`,
      createdAt: '2026-11-01T00:00:00Z',
      lastActiveAt: '2026-11-01T00:00:00Z',
      lastOutputAt: null,
      lastInputAt: null,
      lastResumedAt: null,
      archived: true,
      workState: null,
      machineId: f.store.hostMachineId,
    })
  }
}

describe('the server setup answer', () => {
  it('starts unfinished, and completing without a session reaches another server and survives reopening', async () => {
    const path = mkdtempSync(join(tmpdir(), 'podium-setup-answer-'))
    directories.push(path)
    const first = await fixture(join(path, 'store.db'))
    const second = await fixture(join(path, 'store.db'))
    expect(await first.viewer()).toMatchObject({
      setupFinished: false,
      capabilities: { setUpServer: true },
    })
    expect(await second.viewer()).toMatchObject({ setupFinished: false })
    for (let attempt = 0; attempt < 2; attempt++) {
      const response = await first.request('setup/finish', first.admin, 'POST')
      expect(response.status).toBe(200)
      expect(await response.json()).toEqual({ setupFinished: true })
    }
    expect(await first.store.sessions.hasAnySession()).toBe(false)
    expect(await second.viewer()).toMatchObject({ setupFinished: true })
    for (const store of stores.splice(0).reverse()) await store.close()
    const reopened = await fixture(join(path, 'store.db'))
    expect(await reopened.viewer()).toMatchObject({ setupFinished: true })
  })

  it('answers from instance-wide existence even when the only session is archived or deleted', async () => {
    const f = await fixture()
    const member = await f.identity.addMember({ name: 'Member', email: 'member@example.com' })
    expect(await f.viewer()).toMatchObject({ setupFinished: false })
    await seedSessions(f, 1)
    expect(await f.store.settings.setupFinished()).toBe(false)
    expect(await f.viewer()).toMatchObject({ setupFinished: true })
    // A member with none of this work gets the same instance fact, but never setup.
    expect(await (await f.request('viewer', member)).json()).toMatchObject({
      setupFinished: true,
      capabilities: { setUpServer: false },
    })
    await f.store.sessions.softDeleteSessions(
      fixtureWriteScope(),
      [asSessionId('setup-session-0')],
      '2026-11-17T12:00:00Z',
      'standalone',
    )
    expect(await f.viewer()).toMatchObject({ setupFinished: true })
  })

  it('allows only the installer to finish, and refuses a foreign origin', async () => {
    const f = await fixture()
    const member = await f.identity.addMember({ name: 'Member', email: 'member@example.com' })
    const laterAdmin = await f.identity.addMember({
      name: 'Later admin',
      email: 'admin@example.com',
      role: 'admin',
    })
    for (const [who, status] of [
      [null, 401],
      [member, 403],
      [laterAdmin, 403],
    ] as const) {
      expect((await f.request('setup/finish', who, 'POST')).status).toBe(status)
    }
    expect(
      (await f.request('setup/finish', f.admin, 'POST', 'https://elsewhere.example')).status,
    ).toBe(403)
    expect(await f.viewer()).toMatchObject({ setupFinished: false })
  })
})

describe('setup statement counts', () => {
  const pin = (
    complete: boolean,
    finish = false,
  ): StatementPin<Awaited<ReturnType<typeof fixture>>> => ({
    name: finish ? 'finish setup' : `viewer setup answer (completed=${complete})`,
    setup: async (size) => {
      const f = await fixture()
      await seedSessions(f, size)
      if (complete) await f.store.settings.finishSetup()
      return f
    },
    target: ({ store }) => store,
    run: async (f) =>
      finish ? (await f.request('setup/finish', f.admin, 'POST')).json() : f.viewer(),
    check: (result) => expect(result).toMatchObject({ setupFinished: true }),
    teardown: async ({ store }) => {
      stores.splice(stores.indexOf(store), 1)
      await store.close()
    },
  })

  it('uses one bounded existence query, skips it after completion, and writes completion once', async () => {
    await expectConstantStatements(pin(false), 4)
    await expectConstantStatements(pin(true), 3)
    await expectConstantStatements(pin(false, true), 3)
    await expectArmed(pin(false), 4, ({ store }) => {
      const read = store.sessions.hasAnySession.bind(store.sessions)
      const spy = vi.spyOn(store.sessions, 'hasAnySession').mockImplementation(async () => {
        for (const row of await store.sessions.loadSessions())
          await store.sessions.getSession(row.id)
        return read()
      })
      return () => spy.mockRestore()
    })
  })
})
