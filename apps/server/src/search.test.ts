import { asIssueId, asMachineId, asThreadId, asUserId, firstAdminMemberId } from '@podium/model'
import { SearchResultWire } from '@podium/protocol'
import { afterEach, describe, expect, it } from 'vitest'
import { z } from 'zod'
import { resolvePrincipal, userCommandPrincipal } from './command-principal'
import { MEMORY_EXISTENCE_POLICY, MemoryVisibilityPolicy } from './modules/memory/visibility'
import { SuperagentService } from './modules/superagent'
import { SessionRegistry } from './relay'
import { RepoRegistry } from './repo-registry'
import { appRouter } from './router'
import { OPERATOR } from './test-support/capabilities'
import { forceFeature } from './test-support/features'
import { attachHostDaemon, confirmingRetirement } from './test-support/host-daemon'
import { openTestStore } from './test-support/open-test-store'
import { countStatements, quietShipping, type StatementTally } from './test-support/statement-count'

// Omni-search reads the full-text index, and whether a boot HAS one is the
// `command-palette` flag (PDM-25). These tests are about the indexed path, so
// they force it on before any store is constructed.
forceFeature('command-palette', true)

/** The fixture's caller. `addComment` requires a principal (POD-1315) — these
 *  tests exercise the operator seam, so they say so rather than defaulting. */
const AS_OPERATOR = userCommandPrincipal(firstAdminMemberId(), 'admin')

const READER = { kind: 'user' as const, id: firstAdminMemberId() }

/**
 * Attach the fixture daemon 'm1' as the machine that runs agents and reports the
 * fixture repos (POD-4631): placement refuses a machine with no row assigned
 * `agentExecution`, and an issue's repo resolves only through a reporting machine.
 */
async function attachFixtureDaemon(registry: SessionRegistry): Promise<void> {
  const store = registry.sessionStore
  await store.machines.upsertMachine({
    id: 'm1',
    name: 'm1',
    hostname: 'm1',
    tokenHash: 'm1',
    ownerUserId: firstAdminMemberId(),
    assignment: { server: false, agentExecution: true },
  })
  for (const path of ['/repo', '/private']) await store.repos.addRepo(path, asMachineId('m1'))
  await registry.gateway.attachDaemon('m1', confirmingRetirement(registry, 'm1', () => {}))
}

/** The statements of `tally` that read `table`, and the queries for a failure message. */
function readsOf(tally: StatementTally, table: string): { count: number; queries: string } {
  const hits = [...tally.byQuery].filter(([key]) => key.includes(`from "${table}"`))
  return {
    count: hits.reduce((sum, [, n]) => sum + n, 0),
    queries: hits.map(([key, n]) => `${n}x ${key}`).join('\n'),
  }
}

/**
 * Finish the fixture's background work, so a counted window holds only the
 * operation. The Shipping scheduler and connect-time recovery stop
 * (POD-6183); the feed publication of the fixture's own writes, which reads
 * the issues and sessions it scopes, starts now instead of at the next store
 * idle. That publication is not awaitable, so wait for a window with no
 * statement at all.
 */
async function settle(registry: SessionRegistry): Promise<void> {
  await quietShipping(registry)
  registry.modules.funnel.flushDeltas()
  for (let attempt = 0; attempt < 40; attempt++) {
    const window = await countStatements(registry.sessionStore, () => new Promise((resolve) => setTimeout(resolve, 25)))
    if (window.statements === 0) return
  }
  throw new Error('the fixture kept running statements')
}

// Omni-search (docs/spec/search-v1.md §2.4): one query, ranked typed hits across
// sessions, issues (+comments), conversations, lake-indexed transcripts and the
// settings catalog.

describe('MemoryService omni-search', () => {
  const registries: SessionRegistry[] = []
  afterEach(async () => {
    for (const r of registries.splice(0)) await r.dispose()
  })

  /** A store + registry seeded with one hit per source for the word "capacitor". */
  async function seed() {
    const store = await openTestStore(':memory:')
    const registry = await SessionRegistry.create(store, undefined, { instanceId: 'default' })
    registries.push(registry)
    await attachFixtureDaemon(registry)

    // Session named after the phrase.
    const { sessionId } = await registry.modules.sessions.createSession({
      agentKind: 'claude-code',
      cwd: '/w',
    })
    await registry.modules.sessions.renameSession({ sessionId, name: 'capacitor refactor' })
    await registry.gateway.routeDaemonFrame('m1', {
      type: 'sessionResumeRef',
      sessionId,
      resume: { kind: 'claude-session', value: 'native-tx' },
    })

    // Issue with the phrase in the title; a second issue matching only via comment.
    const issue = await registry.issues.crud.create({
      repoPath: '/repo',
      title: 'replace the flux capacitor',
      description: 'it drifts',
      startNow: false,
    })
    const commentIssue = await registry.issues.crud.create({
      repoPath: '/repo',
      title: 'unrelated title',
      description: 'nothing relevant',
      startNow: false,
    })
    await registry.issues.commentsMail.addComment(
      commentIssue.id,
      'operator',
      'the capacitor comment trail',
      AS_OPERATOR,
    )

    // Conversation row in the durable index.
    const { sessionId: conversationSessionId } = await registry.modules.sessions.createSession({
      ownerUserId: firstAdminMemberId(),
      agentKind: 'claude-code',
      cwd: '/conversation',
    })
    await registry.gateway.routeDaemonFrame('m1', {
      type: 'sessionResumeRef',
      sessionId: conversationSessionId,
      resume: { kind: 'claude-session', value: 'native-conv' },
    })
    await store.conversations.index.upsert([
      {
        id: 'native-conv',
        agentKind: 'claude-code',
        providerId: 'claude-code-jsonl',
        title: 'capacitor deep dive',
        updatedAt: '2026-07-01T09:00:00.000Z',
        machineId: asMachineId('m1'),
      },
    ])

    // Lake-indexed transcript messages (what the mirror-fed indexer writes).
    await store.conversations.registry.ensure({
      machineId: asMachineId('m1'),
      nativeId: 'native-tx',
      providerId: 'claude-code-jsonl',
      path: '/home/u/.claude/projects/-w/native-tx.jsonl',
    })
    await store.conversations.transcriptIndex.append(
      asMachineId('m1'),
      'native-tx',
      [
        {
          content: 'the flux capacitor lives in engine.ts',
          itemUuid: 'a-1',
          ts: '2026-06-20T10:00:00.000Z',
        },
        { content: 'unrelated chatter about lunch', itemUuid: 'a-2' },
      ],
      500,
    )
    return { store, registry, sessionId, issue, commentIssue }
  }

  it('returns typed hits from every matching source in one call', async () => {
    const { store, registry, sessionId, issue, commentIssue } = await seed()
    const results = await registry.modules.memory.search(READER, { text: 'capacitor' })

    const kinds = new Map(results.map((r) => [r.kind, r]))
    expect(kinds.get('session')?.sessionId).toBe(sessionId)
    expect(
      results
        .filter((r) => r.kind === 'issue')
        .map((r) => r.id)
        .sort(),
    ).toEqual([issue.id, commentIssue.id].sort())
    expect(kinds.get('conversation')?.id).toBe('native-conv')
    expect(kinds.get('transcript')?.nativeId).toBe('native-tx')
    // Every hit satisfies the wire contract.
    const shape = z.object({
      kind: z.string(),
      id: z.string(),
      title: z.string(),
      score: z.number(),
    })
    for (const r of results) expect(shape.safeParse(r).success).toBe(true)
  })

  it('ranks sanely: title-matching session/issue above the transcript hit', async () => {
    const { store, registry } = await seed()
    const results = await registry.modules.memory.search(READER, { text: 'capacitor' })
    const rank = (kind: string) => results.findIndex((r) => r.kind === kind)
    expect(rank('session')).toBeGreaterThanOrEqual(0)
    expect(rank('transcript')).toBeGreaterThanOrEqual(0)
    expect(rank('session')).toBeLessThan(rank('transcript'))
    const titleIssue = results.findIndex((r) => r.kind === 'issue' && r.title.includes('flux'))
    expect(titleIssue).toBeLessThan(rank('transcript'))
  })

  it('transcript hits carry an FTS snippet with match markers and registry refs', async () => {
    const { store, registry } = await seed()
    const hit = (await registry.modules.memory
      .search(READER, { text: 'capacitor' }))
      .find((r) => r.kind === 'transcript')
    expect(hit?.snippet).toContain('**capacitor**')
    expect(hit?.machineId).toBe('m1')
    expect(hit?.podiumId).toMatch(/^conv_/)
  })

  it('resolves a live sessionId on a transcript hit when a session resumes that native id', async () => {
    const { registry, sessionId } = await seed()
    const hit = (await registry.modules.memory
      .search(READER, { text: 'engine.ts' }))
      .find((r) => r.kind === 'transcript')
    expect(hit?.sessionId).toBe(sessionId)
  })

  it('matches the settings catalog by label', async () => {
    const { store, registry } = await seed()
    const results = await registry.modules.memory.search(READER, { text: 'notifications' })
    const setting = results.find((r) => r.kind === 'setting')
    expect(setting?.settingKey).toBe('notifications')
    expect(setting?.title).toBe('Settings › Notifications')
  })

  it('respects the limit across the fused list', async () => {
    const { store, registry } = await seed()
    const results = await registry.modules.memory.search(READER, { text: 'capacitor', limit: 2 })
    expect(results.length).toBe(2)
    // The limit trims the tail, not the head: the best hits survive.
    expect(results[0]?.score).toBeGreaterThanOrEqual(results[1]?.score ?? 0)
  })
  it('uses one live-session snapshot and reads issue owners and grants in one batch per pass', async () => {
    const { store, registry } = await seed()
    const liveRows = await store.sessions.loadSessions()
    const issueRows = await store.issues.listIssueRows()
    await settle(registry)
    const loadSessions = store.sessions.loadSessions.bind(store.sessions)
    let loadCalls = 0
    let materializedRows = 0
    store.sessions.loadSessions = async () => {
      loadCalls += 1
      const rows = await loadSessions()
      materializedRows += rows.length
      return rows
    }

    let counted: StatementTally
    try {
      counted = await countStatements(store, () => registry.modules.memory.search(READER, { text: 'capacitor' }))
    } finally {
      store.sessions.loadSessions = loadSessions
    }

    // Before batching, each native candidate loaded every live session. The
    // conserved quantity is one snapshot containing exactly the live rows.
    expect(loadCalls).toBe(1)
    expect(materializedRows).toBe(liveRows.length)
    // THE DEFECT IS THE CONSERVED SQL COUNT. Issue owners were one point read
    // per distinct issue, then (POD-3892) the issue map, then (POD-6195)
    // repository batches. Since POD-6158 the visibility checks ask the issue
    // and grant loaders once per candidate, concurrently, and the loaders batch
    // those asks only inside a scope; without the search's own read scope
    // (POD-6214) this fixture ran a statement per candidate: 4 issue reads and
    // 4 grant reads. Now the issue text match, the commented issues and the
    // candidate issues are one read each, and the grants are one read for the
    // live sessions and one for the candidate issues. Several issues are
    // resolved, so a read per candidate would show:
    expect(issueRows.filter((row) => !row.deletedAt).length).toBeGreaterThan(1)
    const issues = readsOf(counted, 'issues')
    const grants = readsOf(counted, 'grants')
    expect(issues.count, issues.queries).toBe(3)
    expect(grants.count, grants.queries).toBe(2)
  })

  it('reads issue ownership and grants in one batch each for the native conversation list', async () => {
    const store = await openTestStore(':memory:')
    const registry = await SessionRegistry.create(store, undefined, { instanceId: 'default' })
    registries.push(registry)
    await attachFixtureDaemon(registry)

    const issueIds: string[] = []
    const conversationIds: string[] = []
    const issueOwner = asUserId('usr_issue_owner')
    for (let i = 0; i < 4; i++) {
      const issue = await registry.issues.crud.create({
        repoPath: '/repo',
        title: `conversation issue ${i}`,
        startNow: false,
        ownerUserId: issueOwner,
      })
      issueIds.push(issue.id)
      await store.grants.upsert({
        resourceKind: 'issue',
        resourceId: issue.id,
        grantee: READER.id,
        verb: 'read',
        owner: issueOwner,
        visibility: 'personal',
        createdAt: '2026-08-05T00:00:00.000Z',
        actorKind: 'user',
        actorId: READER.id,
        onBehalfOf: READER.id,
      })
      const { sessionId } = await registry.modules.sessions.createSession({
        agentKind: 'claude-code',
        cwd: `/repo/session-${i}`,
        issueId: issue.id,
      })
      const nativeId = `native-conversation-${i}`
      conversationIds.push(nativeId)
      await registry.gateway.routeDaemonFrame('m1', {
        type: 'sessionResumeRef',
        sessionId,
        resume: { kind: 'claude-session', value: nativeId },
      })
      await store.conversations.index.upsert([
        {
          id: nativeId,
          agentKind: 'claude-code',
          providerId: 'claude-code-jsonl',
          projectPath: '/repo',
          machineId: asMachineId('m1'),
        },
      ])
    }

    await settle(registry)
    const counted = await countStatements(store, () =>
      registry.modules.memory.searchConversations(READER, { projectPath: '/repo' }),
    )

    expect(counted.result.map((row) => row.id).sort()).toEqual([...conversationIds].sort())
    // THE DEFECT IS THE CONSERVED SQL COUNT, not a duration. POD-3892 served
    // the issue owners from the issue map; since POD-6195 they are one live
    // batch for the four distinct issues again, and since POD-6158 that batch
    // goes through the issue loader, not getIssues, so the count is taken at
    // the driver. Grants have no copy since POD-6155: the four issues' edges
    // are one batch. A read per owner or per grant edge runs four.
    expect(issueIds).toHaveLength(4)
    const issues = readsOf(counted, 'issues')
    const grants = readsOf(counted, 'grants')
    expect(issues.count, issues.queries).toBe(1)
    expect(grants.count, grants.queries).toBe(1)
  })

  it('returns nothing for blank text (the router schema rejects it upstream too)', async () => {
    const { store, registry } = await seed()
    expect(await registry.modules.memory.search(READER, { text: '   ' })).toEqual([])
  })
})

describe('search.query tRPC', () => {
  const registries: SessionRegistry[] = []
  afterEach(async () => {
    for (const r of registries.splice(0)) await r.dispose()
  })

  it('excludes every private memory source owned by another user', async () => {
    const store = await openTestStore(':memory:')
    const registry = await SessionRegistry.create(store, undefined, { instanceId: 'default' })
    registries.push(registry)
    await attachFixtureDaemon(registry)
    const bob = asUserId('usr_bob')
    const { sessionId } = await registry.modules.sessions.createSession({
      ownerUserId: bob,
      agentKind: 'claude-code',
      cwd: '/classifiedneedle',
    })
    await registry.modules.sessions.renameSession({ sessionId, name: 'classifiedneedle session' })
    registry.gateway.routeDaemonFrame('m1', {
      type: 'sessionResumeRef',
      sessionId,
      resume: { kind: 'claude-session', value: 'classified-native' },
    })
    await store.conversations.index.upsert([
      {
        id: 'classified-native',
        agentKind: 'claude-code',
        providerId: 'claude-code-jsonl',
        machineId: asMachineId('m1'),
        title: 'classifiedneedle conversation',
      },
    ])
    await store.conversations.transcriptIndex.append(
      asMachineId('m1'),
      'classified-native',
      [
        {
          content: 'classifiedneedle transcript',
          itemUuid: 'private-message',
        },
      ],
      100,
    )
    const issue = await registry.issues.crud.create({
      repoPath: '/private',
      title: 'fixture template',
      description: 'private issue body',
      startNow: false,
    })
    const issueRow = await store.issues.getIssue(issue.id)
    if (!issueRow) throw new Error('issue seed missing')
    await store.issues.upsertIssue({
      ...issueRow,
      id: asIssueId('iss_bob_private'),
      seq: issueRow.seq + 1,
      ownerUserId: bob,
      title: 'classifiedneedle issue',
    })
    await store.superagent.upsertSuperagentThread({
      id: 'private-thread',
      ownerUserId: bob,
      kind: 'btw',
      title: 'classifiedneedle superagent',
    })
    await store.superagent.appendSuperagentMessage(asThreadId('private-thread'), {
      role: 'assistant',
      content: 'classifiedneedle private thread body',
    })

    expect(await registry.modules.memory.search(READER, { text: 'classifiedneedle' })).toEqual([])
    const bobHits = await registry.modules.memory.search(
      { kind: 'user', id: bob },
      { text: 'classifiedneedle' },
    )
    expect(new Set(bobHits.map((hit) => hit.kind))).toEqual(
      new Set(['session', 'issue', 'conversation', 'transcript']),
    )
    expect(bobHits.some((hit) => hit.id === 'superagent:private-thread')).toBe(true)
  })

  it('filters hidden transcript ranks before normalizing visible results', async () => {
    const store = await openTestStore(':memory:')
    const registry = await SessionRegistry.create(store, undefined, { instanceId: 'default' })
    registries.push(registry)
    await attachFixtureDaemon(registry)
    const bob = asUserId('usr_bob')
    const bind = async (ownerUserId: typeof bob, nativeId: string, cwd: string) => {
      const { sessionId } = await registry.modules.sessions.createSession({
        ownerUserId,
        agentKind: 'claude-code',
        cwd,
      })
      // The visibility snapshot needs the persisted native-session binding.
      await registry.gateway.routeDaemonFrame('m1', {
        type: 'sessionResumeRef',
        sessionId,
        resume: { kind: 'claude-session', value: nativeId },
      })
    }
    await bind(firstAdminMemberId(), 'visible-rank', '/visible')
    await store.conversations.transcriptIndex.append(
      asMachineId('m1'),
      'visible-rank',
      [
        {
          content: 'rankneedle visible',
          itemUuid: 'visible-rank-message',
        },
      ],
      100,
    )
    const before = (await registry.modules.memory
      .search(READER, { text: 'rankneedle' }))
      .find((hit) => hit.kind === 'transcript')
    expect(before?.id).toBe('visible-rank-message')
    await bind(bob, 'hidden-rank', '/hidden')
    await store.conversations.transcriptIndex.append(
      asMachineId('m1'),
      'hidden-rank',
      [
        {
          content: 'rankneedle rankneedle rankneedle rankneedle',
          itemUuid: 'hidden-rank-message',
        },
      ],
      100,
    )
    const after = (await registry.modules.memory
      .search(READER, { text: 'rankneedle' }))
      .find((hit) => hit.kind === 'transcript')
    expect(after?.id).toBe(before?.id)
    expect(after?.score).toBe(before?.score)
  })

  it('defaults unknown memory classes closed and counts to the visible slice', async () => {
    const store = await openTestStore(':memory:')
    expect(await new MemoryVisibilityPolicy(store).mayRead(READER, { class: 'future-kind' })).toBe(false)
    expect(MEMORY_EXISTENCE_POLICY).toEqual({ counts: 'visible-slice', facets: 'visible-slice' })
    await store.close()
  })

  async function caller() {
    const registry = await SessionRegistry.create(undefined, undefined, { instanceId: 'default' })
    registries.push(registry)
    await attachHostDaemon(registry, () => {})
    const repos = new RepoRegistry(registry, registry.sessionStore)
    const superagent = await SuperagentService.create(registry.modules, repos, registry.sessionStore)
    return {
      registry,
      trpc: appRouter.createCaller({
        registry,
        repos,
        superagent,
        capability: OPERATOR,
        principal: resolvePrincipal(OPERATOR, { parentSessionOf: () => undefined }),
      }),
    }
  }

  it('rejects empty text at the schema', async () => {
    const { trpc } = await caller()
    await expect(trpc.search.query({ text: '' })).rejects.toThrow()
  })

  it('serves ranked results over the wire shape', async () => {
    const { registry, trpc } = await caller()
    const { sessionId } = await registry.modules.sessions.createSession({
      agentKind: 'claude-code',
      cwd: '/w',
    })
    await registry.modules.sessions.renameSession({ sessionId, name: 'quantum toaster' })
    const results = await trpc.search.query({ text: 'quantum' })
    expect(results.map((r) => SearchResultWire.parse(r))).toHaveLength(1)
    expect(results[0]?.sessionId).toBe(sessionId)
  })
})
