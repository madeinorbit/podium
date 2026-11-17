/**
 * EVERY CACHE IS A WORKSPACE'S, OR KEYED BY ONE (POD-6959 design 2.8; task POD-7025).
 *
 * Two workspaces over one database (`openWorkspaceStores`) hold the same key with different
 * values, and each row of the design's cache table is held to what the design says for it:
 *
 *   | What                                   | Held to                                        |
 *   |----------------------------------------|------------------------------------------------|
 *   | `WrittenColumns`, the session hint     | per workspace (repository instance)            |
 *   | the settings snapshot (`committed`)    | per workspace (repository instance)            |
 *   | model catalog snapshots                | per workspace (one catalog per settings store) |
 *   | operation loaders and memos            | per repository instance                        |
 *   | read-scope slots                       | per owner (repository or source object)        |
 *   | committed-row and table-write listeners| per repository instance (see FINDINGS)         |
 *   | machine enrolment transitions          | keyed by host object                           |
 *   | perf principal digests                 | (workspace, principal): NOT YET (see FINDINGS) |
 *   | update coordinator maps                | install-level, by update id                    |
 *   | kind schemas                           | code; the generations are per workspace        |
 *
 * FINDINGS, both reported to the coordinator:
 *   - The table-write announcer (`store/table-writes.ts`) is the DATABASE's, not a repository's:
 *     a write in one workspace announces to every workspace's listeners. It carries no payload
 *     and a listener may only drop what it holds, so nothing crosses; the cost is that another
 *     workspace re-reads. The case below proves the re-read answers its own rows.
 *   - Perf principal digests (`modules/perf/principal.ts`) are keyed by the principal alone. The
 *     memo is a pure hash, so it hands no workspace another's data, but the same member id in
 *     two workspaces lands in one perf partition. The design keys it by (workspace, principal);
 *     the case below is `it.fails` until that lands.
 *
 * CACHES THE TABLE DOES NOT LIST (a sweep of `apps/server/src` and `packages/sync/src` for
 * module-level maps and cache, memo and snapshot fields), also reported:
 *   - `RepoRepository`'s registry read (`store/repos.ts`, `cached`): the `repos` and
 *     `repo_prefixes` rows. Workspace data, per repository instance; the table-write case
 *     below holds it (the same root, a different prefix in each workspace).
 *   - `FeedIdentityRegistry` (`packages/sync/src/feed/identity.ts`, `cached`): the feed's id and
 *     epoch, from `sync_feed`. Workspace data, one registry per relay over its store's sync
 *     repository; the feed identity case below holds it.
 *   - `GreenPrefixCache` (`modules/shipping/queue.ts`), a field of `ShippingService`: green
 *     train prefixes, keyed by repo, target, destination and prefix id but not the workspace.
 *     Per workspace by construction (one shipping service per workspace's graph); if POD-6961
 *     shares one graph across workspaces, its key needs the workspace. Not tested here: an
 *     instance per service holds nothing another instance can see.
 *   - `PictureCache` (`modules/sessions/picture-cache.ts`): one per terminal, filled from the
 *     daemon's output stream, not from a table. No workspace key to get wrong.
 *   - Code-derived, holding no rows: `sync/capture-pg.ts` (`tableCache`, `sourceCache`,
 *     `cascadeCache`, from the schema and the record sources), `static-web.ts` and
 *     `web-bundle-stamp.ts` (files), `trpc.ts` `lastSlowWarnAt` (procedure paths).
 */

import {
  asMachineId,
  asSessionId,
  asUserId,
  type IssueId,
  type MachineId,
  type SessionId,
  type UserId,
} from '@podium/model'
import { normalizeSettings } from '@podium/runtime'
import { FeedIdentityRegistry } from '@podium/sync'
import { fixtureWriteScope } from '@podium/sync/testing'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { type MachineRowSource, ownershipFromMachinesPerPass } from '../machine-access'
import { ModelCatalog } from '../model-catalog'
import { type EnrollmentHost, withMachineTransition } from '../modules/machines/enrollment'
import { perfPrincipal } from '../modules/perf/principal'
import type { SessionStore } from '../store'
import { kindGenerationBump } from '../sync/kind-tokens'
import * as issueSeed from '../test-support/workspace-seeds/issues'
import { openWorkspaceStores } from '../test-support/workspace-stores'
import { withOperation } from './executor/operation-scope'
import { withReadScope } from './executor/read-scope'
import type { IssueRow, SessionRow } from './types'

type Tag = 'a' | 'b'
const TAGS = ['a', 'b'] as const
const WS: Record<Tag, string> = { a: 'ws_a', b: 'ws_b' }
const AT = '2026-11-17T10:00:00.000Z'
const scope = fixtureWriteScope()

// The same keys in both workspaces.
const ALICE: UserId = asUserId('user:alice')
const SID: SessionId = asSessionId('s1')
const ISSUE: IssueId = issueSeed.iss(1)
const MACHINE: MachineId = asMachineId('machine-1')

let stores: Record<Tag, SessionStore>

beforeEach(async () => {
  const [a, b] = await openWorkspaceStores([WS.a, WS.b], { path: ':memory:' })
  stores = { a, b }
})

afterEach(async () => {
  await stores.a.close()
})

interface RawDb {
  prepare(sql: string): { all(...params: unknown[]): unknown[]; run(...params: unknown[]): unknown }
}
const rawDb = (store: SessionStore): RawDb => (store as unknown as { db: RawDb }).db

function session(tag: Tag, patch: Partial<SessionRow> = {}): SessionRow {
  return {
    id: SID,
    ownerUserId: ALICE,
    agentKind: 'codex',
    cwd: '/repo/w1',
    title: `${tag} title`,
    name: null,
    nameSource: null,
    originKind: 'spawn',
    conversationId: null,
    resumeKind: 'codex',
    resumeValue: 'resume-1',
    status: 'live',
    exitCode: null,
    spawnFailure: null,
    durableLabel: 'podium-1',
    createdAt: AT,
    lastActiveAt: AT,
    geometry: { cols: 120, rows: 40 },
    archived: false,
    workState: null,
    machineId: MACHINE,
    lastOutputAt: null,
    lastInputAt: null,
    lastResumedAt: null,
    spawnedBy: null,
    headless: false,
    issueId: null,
    refIssueId: null,
    refLetter: null,
    refDraft: null,
    stoppedAt: null,
    stopReason: null,
    workflowRunId: null,
    workflowStepId: null,
    agentProfileId: null,
    deletedAt: null,
    deletionSource: null,
    deletedByIssueId: null,
    ...patch,
  }
}

/** The issues seed's own row (`test-support/workspace-seeds/issues.ts`): issue 1 of `tag`. */
const issue = (tag: Tag): IssueRow => issueSeed.issue(tag, 1)

describe('the cache table of design 2.8, each row with the same key in both workspaces', () => {
  it('WrittenColumns: the session hint is the repository’s, so each workspace remembers its own row', async () => {
    type Hint = { get(id: string): unknown }
    const hintOf = (store: SessionStore): Hint =>
      (store.sessions as unknown as { writtenColumns: Hint }).writtenColumns
    const inSpan = async <T>(store: SessionStore, fn: () => Promise<T>): Promise<T> =>
      await (
        store.sessions as unknown as {
          createOrJoinTransaction: <R>(run: () => Promise<R>) => Promise<R>
        }
      ).createOrJoinTransaction(fn)
    // The hint remembers the columns an upsert may skip (not the title): the cwd differs.
    for (const tag of TAGS) {
      await stores[tag].sessions.upsertSession(scope, session(tag, { cwd: `/repo-${tag}/w1` }))
    }
    // A read outside a span records what each workspace's row holds.
    for (const tag of TAGS) await stores[tag].sessions.getSession(SID)
    expect(hintOf(stores.a)).not.toBe(hintOf(stores.b))
    for (const tag of TAGS) {
      const remembered = JSON.stringify(
        await inSpan(stores[tag], async () => hintOf(stores[tag]).get(SID)),
      )
      expect(remembered).toContain(`/repo-${tag}/w1`)
      expect(remembered).not.toContain(`/repo-${tag === 'a' ? 'b' : 'a'}/w1`)
    }
    // A's next upsert skips by A's hint and changes A's row; B's row and hint are as they were.
    await stores.a.sessions.upsertSession(scope, session('a', { cwd: '/repo-a/w2' }))
    expect((await stores.a.sessions.getSession(SID))?.cwd).toBe('/repo-a/w2')
    expect((await stores.b.sessions.getSession(SID))?.cwd).toBe('/repo-b/w1')
    expect(JSON.stringify(await inSpan(stores.b, async () => hintOf(stores.b).get(SID)))).toContain(
      '/repo-b/w1',
    )
  })

  it('the settings snapshot is the repository’s: each workspace serves its own blob', async () => {
    const blob = (mirror: boolean) => normalizeSettings({ transcripts: { mirror } })
    await stores.a.settings.setSettings(blob(true))
    await stores.b.settings.setSettings(blob(false))
    for (const tag of TAGS) await stores[tag].settings.initializeSnapshot()
    expect(stores.a.settings.layeredSettings().transcriptLake).toBe('on')
    expect(stores.b.settings.layeredSettings().transcriptLake).toBe('off')
    // A write in A moves A's snapshot only.
    await stores.a.settings.setSettings(blob(false))
    expect(stores.a.settings.layeredSettings().transcriptLake).toBe('off')
    await stores.b.settings.setSettings(blob(true))
    expect(stores.b.settings.layeredSettings().transcriptLake).toBe('on')
    expect(stores.a.settings.layeredSettings().transcriptLake).toBe('off')
  })

  it('model catalog snapshots: one catalog per workspace’s settings, by machine id', async () => {
    const snapshot = (tag: Tag) => ({
      machineId: MACHINE,
      byAgent: { codex: [{ value: `${tag}-model`, label: `${tag} model` }] },
      fetchedAt: Date.now(),
      version: 0,
    })
    // The catalog as the settings service builds it, over each workspace's own store.
    const catalogs = Object.fromEntries(
      TAGS.map((tag) => {
        const settings = stores[tag].settings
        return [
          tag,
          new ModelCatalog(async () => ({}), {
            load: async (machineId) => await settings.getModelCatalog(machineId),
            save: async (value) => await settings.setModelCatalog(value),
          }),
        ]
      }),
    ) as Record<Tag, ModelCatalog>
    const current = (await stores.a.settings.getModelCatalog(MACHINE)) ?? null
    for (const tag of TAGS) {
      await stores[tag].settings.setModelCatalog({
        ...snapshot(tag),
        version: (current as { version?: number } | null)?.version ?? snapshot(tag).version,
      })
    }
    for (const tag of TAGS) {
      const stored = await stores[tag].settings.getModelCatalog(MACHINE)
      expect(JSON.stringify(stored)).toContain(`${tag}-model`)
      expect(JSON.stringify(stored)).not.toContain(`${tag === 'a' ? 'b' : 'a'}-model`)
      // Its catalog hydrates from its own store: refresh, then read.
      catalogs[tag].get(MACHINE)
      await catalogs[tag].refresh(MACHINE)
      expect(JSON.stringify(catalogs[tag].get(MACHINE))).not.toContain(
        `${tag === 'a' ? 'b' : 'a'}-model`,
      )
    }
  })

  it('operation loaders and memos are the repository’s: one operation reading both workspaces gets each its own', async () => {
    for (const tag of TAGS) {
      await stores[tag].sessions.upsertSession(scope, session(tag))
      await stores[tag].issues.upsertIssue(scope, issue(tag))
      await stores[tag].settings.setSettingsFor(
        ALICE,
        normalizeSettings({ transcripts: { mirror: tag === 'a' } }) as never,
        AT,
      )
    }
    await withOperation(async () => {
      for (const tag of TAGS) {
        const s = stores[tag]
        expect((await s.sessions.loadSession(SID))?.title).toBe(`${tag} title`)
        expect((await s.issues.loadIssue(ISSUE))?.title).toBe(`${tag} issue 1`)
        expect((await s.issues.loadIssues([ISSUE])).get(ISSUE)?.title).toBe(`${tag} issue 1`)
      }
      // And again, now that each memo holds its answer.
      for (const tag of TAGS) {
        expect((await stores[tag].sessions.loadSession(SID))?.title).toBe(`${tag} title`)
        expect((await stores[tag].issues.loadIssue(ISSUE))?.title).toBe(`${tag} issue 1`)
      }
    })
  })

  it('read-scope slots are their owner’s: a repository’s row cache and a machine source’s ownership pass', async () => {
    for (const tag of TAGS) await stores[tag].issues.upsertIssue(scope, issue(tag))
    // Each workspace's machine source: the same machine id, a different name.
    const source = (tag: Tag): MachineRowSource =>
      ({
        ownershipRows: () => [
          {
            id: MACHINE,
            name: `${tag} box`,
            daemonAssigned: true,
            daemonAvailable: true,
            revokedAt: null,
          },
        ],
      }) as unknown as MachineRowSource
    const sources = { a: source('a'), b: source('b') }
    await withReadScope(async () => {
      for (const tag of TAGS) {
        expect((await stores[tag].issues.getIssue(ISSUE))?.title).toBe(`${tag} issue 1`)
        expect(ownershipFromMachinesPerPass(sources[tag]).rowFor(MACHINE)?.name).toBe(`${tag} box`)
      }
      for (const tag of TAGS) {
        expect((await stores[tag].issues.getIssue(ISSUE))?.title).toBe(`${tag} issue 1`)
        expect(ownershipFromMachinesPerPass(sources[tag]).rowFor(MACHINE)?.name).toBe(`${tag} box`)
      }
    })
  })

  it('committed-row and access listeners are the repository’s: a write in A tells A’s listeners only', async () => {
    const heard: Record<Tag, string[]> = { a: [], b: [] }
    for (const tag of TAGS) {
      stores[tag].issues.committed.subscribe(() => heard[tag].push('issues'))
      stores[tag].grants.committed.subscribe(() => heard[tag].push('grants'))
      stores[tag].users.committed.subscribe(() => heard[tag].push('users'))
      stores[tag].machines.committed.subscribe(() => heard[tag].push('machines'))
      stores[tag].messages.committed.subscribe(() => heard[tag].push('messages'))
      stores[tag].effects.onCommitted(() => heard[tag].push('effects'))
      stores[tag].users.onAccessChange(() => heard[tag].push('access'))
    }
    await stores.a.issues.upsertIssue(scope, issue('a'))
    await stores.a.grants.upsert({
      resourceKind: 'issue',
      resourceId: ISSUE,
      grantee: ALICE,
      verb: 'read',
      owner: ALICE,
      visibility: 'shared',
      createdAt: AT,
      actorKind: 'user',
      actorId: ALICE,
      onBehalfOf: ALICE,
    })
    await stores.a.machines.upsertMachine({
      id: MACHINE,
      name: 'a box',
      hostname: 'a-host',
      tokenHash: 'a-token',
      ownerUserId: ALICE,
    })
    await stores.a.effects.insert(
      scope,
      {
        id: 'eff-1',
        kind: 'a.kind',
        target: { kind: 'issue', id: ISSUE },
        input: {},
        createdBy: ALICE,
        deadlineAt: undefined,
      },
      Date.now(),
    )
    expect(heard.a).toEqual(expect.arrayContaining(['issues', 'grants', 'machines', 'effects']))
    expect(heard.b).toEqual([])
  })

  it('the table-write announcer is the database’s (a finding): B re-reads, and reads its own rows', async () => {
    // The same root in both workspaces, a different prefix in each.
    await stores.a.repos.addRepo('/repo', MACHINE, 'https://example.test/project.git', 'AAA')
    await stores.b.repos.addRepo('/repo', MACHINE, 'https://example.test/project.git', 'BBB')
    // Each repository holds its registry read.
    expect(await stores.a.repos.prefixForPath('/repo/src')).toBe('AAA')
    expect(await stores.b.repos.prefixForPath('/repo/src')).toBe('BBB')
    expect(stores.a.tableWrites).toBe(stores.b.tableWrites)
    // A write announced in A drops B's held read too; B's re-read is B's own.
    stores.a.tableWrites.wrote('repos', 'repo_prefixes')
    expect(await stores.b.repos.prefixForPath('/repo/src')).toBe('BBB')
    await stores.a.repos.setRepoPrefix(MACHINE, '/repo', 'AAB')
    expect(await stores.a.repos.prefixForPath('/repo/src')).toBe('AAB')
    expect(await stores.b.repos.prefixForPath('/repo/src')).toBe('BBB')
  })

  it('the feed identity registry (not in the table) is its store’s: each workspace holds, bumps and re-reads its own', async () => {
    // The same feed id in both workspaces, a different epoch in each.
    for (const tag of TAGS) {
      await stores[tag].sync.writeFeedIdentity({ feedId: 'feed-1', epoch: `epoch-${tag}` }, 1)
    }
    const registry = (tag: Tag) =>
      new FeedIdentityRegistry(
        {
          readIdentity: async () => await stores[tag].sync.readFeedIdentity(),
          writeIdentity: async (identity) => await stores[tag].sync.writeFeedIdentity(identity, 2),
        },
        () => `epoch-${tag}-bumped`,
      )
    const a = registry('a')
    const b = registry('b')
    expect(await a.resolve()).toEqual({ feedId: 'feed-1', epoch: 'epoch-a' })
    expect(await b.resolve()).toEqual({ feedId: 'feed-1', epoch: 'epoch-b' })
    // A bump in A is A's: B's held identity and B's row stay as they were.
    expect((await a.bump('restore')).epoch).toBe('epoch-a-bumped')
    expect(b.current()).toEqual({ feedId: 'feed-1', epoch: 'epoch-b' })
    expect(await registry('b').resolve()).toEqual({ feedId: 'feed-1', epoch: 'epoch-b' })
    expect(await registry('a').resolve()).toEqual({ feedId: 'feed-1', epoch: 'epoch-a-bumped' })
  })

  it('machine enrolment transitions are keyed by host: one machine id in two workspaces does not wait on the other', async () => {
    const host = (): EnrollmentHost =>
      ({
        deps: {},
        hasSupervisor: () => false,
        retireIncarnation: () => {},
      }) as unknown as EnrollmentHost
    const hosts = { a: host(), b: host() }
    const order: string[] = []
    let releaseA!: () => void
    const heldA = new Promise<void>((resolve) => {
      releaseA = resolve
    })
    const a = withMachineTransition(hosts.a, MACHINE, async () => {
      order.push('a start')
      await heldA
      order.push('a end')
    })
    // B's transition of the same machine id runs while A's is held.
    await withMachineTransition(hosts.b, MACHINE, async () => {
      order.push('b')
    })
    // A second transition on A's host waits for A's.
    const a2 = withMachineTransition(hosts.a, MACHINE, async () => {
      order.push('a2')
    })
    expect(order).toEqual(['a start', 'b'])
    releaseA()
    await Promise.all([a, a2])
    expect(order).toEqual(['a start', 'b', 'a end', 'a2'])
  })

  it.fails('perf principal digests are keyed by (workspace, principal) (design 2.8; not yet: a finding)', () => {
    // perfPrincipal takes no workspace: the same member id in two workspaces is one digest.
    // This fails until the digest names the workspace; then drop `.fails`.
    const inA = perfPrincipal({ kind: 'user', user: ALICE } as never)
    const inB = perfPrincipal({ kind: 'user', user: ALICE } as never)
    expect(inA.digest).not.toBe(inB.digest)
  })

  it('perf principal digests hold no workspace data: the memo is a pure hash of the principal', () => {
    const first = perfPrincipal({ kind: 'user', user: ALICE } as never)
    const again = perfPrincipal({ kind: 'user', user: ALICE } as never)
    const other = perfPrincipal({ kind: 'user', user: asUserId('user:bob') } as never)
    expect(again).toEqual(first)
    expect(other.digest).not.toBe(first.digest)
  })

  it('update coordinator state is the install’s: both workspaces read and write the one checkpoint', async () => {
    const checkpoint = (lastGrantAuthority: number) => ({
      format: 1 as const,
      lastGrantAuthority,
      targets: [],
      machines: [],
      grants: [],
      rollouts: [],
    })
    await stores.a.updateRecovery.write(() => checkpoint(1) as never)
    expect(await stores.b.updateRecovery.read()).toEqual(checkpoint(1))
    await stores.b.updateRecovery.write(() => checkpoint(2) as never)
    expect(await stores.a.updateRecovery.read()).toEqual(checkpoint(2))
  })

  it('kind schemas are code; the kind generations they pair with are each workspace’s own', async () => {
    const generations = (tag: Tag) =>
      rawDb(stores.a)
        .prepare('SELECT kind, generation FROM sync_kind WHERE workspace_id = ? AND kind = ?')
        .all(WS[tag], 'bench-kind') as { generation: number }[]
    // The bump the migrations use: one row per provisioned workspace.
    rawDb(stores.a)
      .prepare(kindGenerationBump(['bench-kind' as never]))
      .run()
    const first = TAGS.map((tag) => generations(tag).map((row) => Number(row.generation)))
    expect(first.every((rows) => rows.length === 1)).toBe(true)
    // A workspace's own bump moves its row only.
    rawDb(stores.a)
      .prepare(
        "UPDATE sync_kind SET generation = generation + 1 WHERE workspace_id = ? AND kind = 'bench-kind'",
      )
      .run(WS.a)
    expect(Number(generations('a')[0]?.generation)).toBe(first[0]![0]! + 1)
    expect(Number(generations('b')[0]?.generation)).toBe(first[1]![0]!)
  })
})
