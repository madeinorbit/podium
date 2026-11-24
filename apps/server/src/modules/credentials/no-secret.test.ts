/**
 * NO SECRET LEAVES (credential management Task 4, acceptance 4).
 *
 * `credentials.add` and `credentials.renew` run on the running router over a real
 * store. Afterwards the planted secrets are in none of: the command results, the
 * credential events, any table of the database (the command journal, the sync
 * change log and every other), and the output of `credentials.list`. Each search
 * first proves it can find a planted value, so an empty result means something.
 */

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Capability } from '@podium/model'
import { asUserId } from '@podium/model'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { resolvePrincipal } from '../../command-principal'
import { SessionRegistry } from '../../relay'
import { RepoRegistry } from '../../repo-registry'
import { appRouter } from '../../router'
import { SELF_HOSTED_WORKSPACE_ID } from '../../self-hosted-workspace'
import type { SessionStore } from '../../store'
import { memberFacts } from '../../store/fixtures/test-support'
import { acceptingProviderFetch } from '../../test-support/fake-provider'
import { SuperagentService } from '../superagent'
import { withSecret } from './vault'

const OWNER = asUserId('user:no-secret-owner')
const ADDED = 'FAKE-sk-ant-plant-6891-added'
const RENEWED = 'FAKE-sk-ant-plant-6891-renewed'
const CANARY = 'FAKE-canary-6891-label'

const owner: Capability = {
  role: 'worker',
  scope: { kind: 'owned', userId: OWNER },
  actorUser: OWNER,
  onBehalfOf: OWNER,
}

/** Every table whose rows mention `needle`, read raw, and the tables read. */
function tablesHolding(store: SessionStore, needle: string): { found: string[]; read: string[] } {
  // @ts-expect-error reach the private db for a whole-database read
  const db = store.db as { prepare(sql: string): { all(): unknown[] } }
  const tables = (
    db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'")
      .all() as { name: string }[]
  ).map(({ name }) => name)
  const found = tables.filter((name) =>
    db
      .prepare(`SELECT * FROM "${name}"`)
      .all()
      .some((row) => JSON.stringify(row).includes(needle)),
  )
  return { found, read: tables }
}

const priorStateDir = process.env.PODIUM_STATE_DIR
let dir: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'podium-cred-no-secret-'))
  process.env.PODIUM_STATE_DIR = dir
})
afterEach(() => {
  process.env.PODIUM_STATE_DIR = priorStateDir
  rmSync(dir, { recursive: true, force: true })
})

describe('acceptance 4: no secret leaves add or renew', () => {
  it('the result, the events, every table and credentials.list hold neither secret', async () => {
    const registry = await SessionRegistry.create(undefined, undefined, {
      instanceId: 'default',
      // Adding a key asks its provider; a test never reaches a real one (Task 13).
      credentialProviderFetch: acceptingProviderFetch,
    })
    const repos = new RepoRegistry(registry, registry.sessionStore)
    const superagent = await SuperagentService.create(
      registry.modules,
      repos,
      registry.sessionStore,
    )
    const store = registry.sessionStore
    await memberFacts(store).create(
      {
        id: OWNER,
        displayName: 'Owner',
        role: 'member',
        createdAt: new Date().toISOString(),
        disabledAt: null,
      },
      'not-a-real-hash',
    )
    const caller = appRouter.createCaller({
      registry,
      repos,
      superagent,
      users: store.users,
      loginRequired: async () => true,
      capability: owner,
      principal: resolvePrincipal(SELF_HOSTED_WORKSPACE_ID, owner, {
        parentSessionOf: () => undefined,
      }),
    })

    const added = await caller.credentials.add({
      type: 'anthropic.api-key',
      label: CANARY,
      secret: ADDED,
    })
    const renewed = await caller.credentials.renew({
      credentialId: added.credentialId,
      secret: RENEWED,
    })
    const listed = await caller.credentials.list()

    // Positive controls: both writes landed, and the searches can find a plant.
    expect(await withSecret(store, added.credentialId, async (s) => s)).toBe(RENEWED)
    expect(JSON.stringify(listed)).toContain(CANARY)
    const canary = tablesHolding(store, CANARY)
    expect(canary.found).toEqual(['credentials'])
    expect(canary.read).toEqual(
      // The command journal, the sync stream and the vault's own table are among those read.
      expect.arrayContaining([
        'settings_audit_events',
        'applied_mutations',
        'changes',
        'credential_secrets',
      ]),
    )
    const events = (await store.settingsAudit.list(1000)).filter((row) =>
      row.command.startsWith('credentials.'),
    )
    expect(events.map((row) => row.command)).toEqual(
      expect.arrayContaining(['credentials.add', 'credentials.renew']),
    )
    expect(JSON.stringify(events)).toContain(added.credentialId)

    for (const plant of [ADDED, RENEWED]) {
      expect(JSON.stringify(added)).not.toContain(plant)
      expect(JSON.stringify(renewed)).not.toContain(plant)
      expect(JSON.stringify(events)).not.toContain(plant)
      expect(JSON.stringify(listed)).not.toContain(plant)
      expect(tablesHolding(store, plant).found).toEqual([])
    }
    // The identity shows a mask, never the key.
    expect(listed[0]?.identity.masked).toBe('FAKE…ewed')
  })
})
