import { resolvePrincipal } from '../../command-principal'
/**
 * THE SETTINGS GATE AND TRAIL, AGAINST THE REAL DERIVED ROUTER (POD-421).
 *
 * `authz.test.ts` and `audit.test.ts` drive the decision function and the record
 * builder. Both would pass in full against a router that calls NEITHER — which
 * is precisely the defect this issue exists to close, one level down: POD-420's
 * `roleFloor` was declared, internally consistent, and read by nothing. A suite
 * that only exercises the function reproduces that failure in the tests.
 *
 * So this file asserts against the object the server actually serves, with a
 * real `SessionStore` and a real migration-created `users` row.
 *
 * ---------------------------------------------------------------------------
 * THE ONE FACT THIS SUITE HAS TO FAKE, AND WHY IT IS THE HONEST CHOICE
 * ---------------------------------------------------------------------------
 *
 * Every transport call resolves to `FIRST_ADMIN_USER_ID` — `resolvePrincipal`
 * returns it for any capability without an `actorSessionId`, because
 * `CLIENT_PRINCIPAL_GRADE` is still `device` and per-user login is POD-315's.
 * There is no way to log in as a member, so a refusal cannot be produced through
 * the transport at all today.
 *
 * The alternative to faking something would be to skip the refusing arm through
 * the router — and an untested refusing arm is exactly how POD-391's CSWSH guard
 * survived deletion with twenty green tests. So this suite overrides ONE method
 * on the real store, `users.roleOf`, which is the single point the gate consults
 * for the account grade. Everything else — the router, the procedures, the
 * service, the secret store, the audit table — is the product.
 *
 * Stated plainly so nobody reads more into a green run than it proves: this
 * shows the derived router CALLS the gate and honours its answer. It does not
 * show that a second human can be authenticated, because on this build one
 * cannot be.
 */

import { FIRST_ADMIN_USER_ID, type UserRole } from '@podium/model'
import { describe, expect, it } from 'vitest'
import { PairingManager } from '../../hub/pairing'
import { OPERATOR } from '../../issue-authz'
import { SessionRegistry } from '../../relay'
import { RepoRegistry } from '../../repo-registry'
import { appRouter } from '../../router'
import { SessionStore } from '../../store'
import { SuperagentService } from '../superagent'
import { SECRET_SURFACE_ABSENT } from './authz'

const SECRET = 'sk-ant-real-material-do-not-log'

function harness(role: UserRole | undefined) {
  const store = new SessionStore(':memory:')
  const registry = new SessionRegistry(store, undefined, { pairing: new PairingManager() })
  registry.modules.machines.ensureLocalMachine()

  // Override only after boot has loaded the real migration account. The command
  // gate must see the requested role (including unreadable), while unrelated
  // session-state bootstrap remains a production-valid account read.
  const users = store.users as { roleOf: (id: string) => UserRole | undefined }
  users.roleOf = (id: string) => (id === FIRST_ADMIN_USER_ID ? role : undefined)
  const repos = new RepoRegistry(registry, registry.sessionStore)
  const superagent = new SuperagentService(registry.modules, repos, registry.sessionStore)
  return {
    store,
    call: appRouter.createCaller({ registry, repos, superagent, capability: OPERATOR, principal: resolvePrincipal(OPERATOR, { parentSessionOf: () => undefined }) }),
    audit: () => store.settingsAudit.list(),
  }
}

describe('the derived settings router CALLS the gate', () => {
  it('an admin may read the secret presence surface', async () => {
    // THE POSITIVE ARM FIRST. Every refusal below is worthless without it: a
    // gate that refused everything satisfies them all.
    const { call } = harness('admin')
    const presence = await call.settings.secretPresence({})
    expect(Array.isArray(presence)).toBe(true)
    expect(presence.length).toBeGreaterThan(0)
  })

  it('a member reading the secret surface is refused AS ABSENT, not as forbidden', async () => {
    const { call } = harness('member')
    await expect(call.settings.secretPresence({})).rejects.toMatchObject({
      code: 'NOT_FOUND',
      message: SECRET_SURFACE_ABSENT,
    })
  })

  it('a member is refused a secret WRITE', async () => {
    const { call } = harness('member')
    await expect(
      call.settings.setSecret({ key: 'apiKeys.openai', value: SECRET }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' })
  })

  it('…and the refused write did NOT happen — the gate runs BEFORE the handler', async () => {
    // A gate that refused after the side effect would pass the test above and
    // be worthless. Read back through the admin surface, which is the only
    // reader that can see it.
    const { call, store } = harness('member')
    await call.settings.setSecret({ key: 'apiKeys.openai', value: SECRET }).catch(() => {})
    expect(store.secrets.getOrEmpty('apiKeys.openai')).toBe('')
  })

  it('a member MAY still write their own preferences — the member floor is real', async () => {
    // The control that stops "members are refused" from being the whole gate.
    // If this failed, the settings screen would be unusable for everyone but an
    // admin and the split would be a pretence.
    const { call } = harness('member')
    const saved = await call.settings.updatePersonal({
      values: { 'notifications.telegramChatId': '4242' },
    })
    expect(saved.notifications.telegramChatId).toBe('4242')
  })

  it('an account with no readable row is refused even the member-floor command', async () => {
    // A VALID patch, deliberately: an empty `values` is refused by the input
    // SCHEMA before the procedure body runs, so using one here would have
    // asserted zod's refusal and read as the gate's. The two are different
    // mechanisms and the test must name which one it is exercising.
    const { call } = harness(undefined)
    await expect(
      call.settings.updatePersonal({ values: { 'notifications.telegramChatId': '4242' } }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' })
  })
})

describe('the derived settings router WRITES the trail', () => {
  it('records an applied secret write, with the key and without the material', async () => {
    const { call, audit } = harness('admin')
    await call.settings.setSecret({ key: 'apiKeys.openai', value: SECRET })
    const rows = audit().filter((r) => r.command === 'settings.setSecret')
    expect(rows).toHaveLength(1)
    expect(rows[0]?.outcome).toBe('applied')
    expect(rows[0]?.redactedPaths).toEqual(['value'])
    // Against the WHOLE serialized row read back out of SQLite through the
    // repository, not against the object that was handed to it.
    expect(JSON.stringify(rows[0])).not.toContain(SECRET)
    expect((rows[0]?.detail as { input: { key: string } }).input.key).toBe('apiKeys.openai')
  })

  it('records a REFUSED write, and the refusal still carries no material', async () => {
    // The error path through the real transport. A member's refused `setSecret`
    // arrives with the material in its input; the trail must not keep it.
    const { call, audit } = harness('member')
    await call.settings.setSecret({ key: 'apiKeys.openai', value: SECRET }).catch(() => {})
    const rows = audit().filter((r) => r.command === 'settings.setSecret')
    expect(rows).toHaveLength(1)
    expect(rows[0]?.outcome).toBe('refused')
    expect(JSON.stringify(rows[0])).not.toContain(SECRET)
    expect((rows[0]?.detail as { error: string }).error).toContain('admin')
  })

  it('records a handler-thrown refusal, not only a gate refusal', async () => {
    // `normalizeSettings` refuses a value the model's schema rejects, INSIDE the
    // handler. A trail wired only to the gate would miss every validation
    // refusal — which is most of them.
    const { call, audit } = harness('admin')
    await call.settings
      .updateInstance({ values: { 'hibernation.memoryPct': 'not-a-number' } })
      .catch(() => {})
    const rows = audit().filter((r) => r.command === 'settings.updateInstance')
    expect(rows).toHaveLength(1)
    expect(rows[0]?.outcome).toBe('refused')
    expect(rows[0]?.detail).toHaveProperty('error')
  })

  it('the trail is EMPTY before any settings command — it is not pre-seeded', async () => {
    // Non-vacuity: every count above would also hold if the table were
    // pre-populated by something else, and an "is not empty" claim proves
    // nothing about what wrote the rows.
    const { audit } = harness('admin')
    expect(audit()).toEqual([])
  })

  it('every row carries the attribution pair, and a person is on both halves', async () => {
    const { call, audit } = harness('admin')
    await call.settings.clearSecret({ key: 'apiKeys.openai' })
    const row = audit().at(-1)
    expect(row?.actorKind).toBe('user')
    expect(row?.actorId).toBe(FIRST_ADMIN_USER_ID)
    expect(row?.onBehalfOf).toBe(FIRST_ADMIN_USER_ID)
  })
})

describe('the STORE refuses a system row that names a human (ADR 9 D8 S5)', () => {
  it('the CHECK constraint rejects it, independently of the writer', async () => {
    // Two mechanisms over one rule, per ADR 9 D4 point 2. `settingsAuditRow`
    // derives the human from the principal KIND so this is unreachable through
    // the product — this asserts the table would refuse it even if that code
    // were wrong, which is the only version of the claim that survives a future
    // edit to the writer.
    const { store } = harness('admin')
    store.settingsAudit.append({
      command: 'settings.updateInstance',
      outcome: 'applied',
      actorKind: 'system',
      actorId: 'system:steward',
      onBehalfOf: null,
      detail: {},
      redactedPaths: [],
      createdAt: '2026-07-31T00:00:00.000Z',
    })
    expect(store.settingsAudit.list().at(-1)?.actorKind).toBe('system')

    expect(() =>
      store.settingsAudit.append({
        command: 'settings.updateInstance',
        outcome: 'applied',
        actorKind: 'system',
        actorId: 'system:steward',
        // The defect: a system write attributed to a person.
        onBehalfOf: FIRST_ADMIN_USER_ID,
        detail: {},
        redactedPaths: [],
        createdAt: '2026-07-31T00:00:00.000Z',
      }),
    ).toThrow()
  })
})
