import { asIssueId, asMachineId, asThreadId, asUserId, firstAdminMemberId, type UserId } from '@podium/model'
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
import { openTestStore } from './test-support/open-test-store'

// Omni-search reads the full-text index, and whether a boot HAS one is the
// `command-palette` flag (PDM-25). These tests are about the indexed path, so
// they force it on before any store is constructed.
forceFeature('command-palette', true)

/** The fixture's caller. `addComment` requires a principal (POD-1315) — these
 *  tests exercise the operator seam, so they say so rather than defaulting. */
const AS_OPERATOR = userCommandPrincipal(firstAdminMemberId(), 'admin')

const READER = { kind: 'user' as const, id: firstAdminMemberId() }

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
    registry.gateway.attachDaemon('m1', () => {})

    // Session named after the phrase.
    const { sessionId } = await registry.modules.sessions.createSession({
      agentKind: 'claude-code',
      cwd: '/w',
    })
    await registry.modules.sessions.renameSession({ sessionId, name: 'capacitor refactor' })
    registry.gateway.routeDaemonFrame('m1', {
      type: 'sessionResumeRef',
      sessionId,
      resume: { kind: 'claude-session', value: 'native-tx' },
    })

    // Issue with the phrase in the title; a second issue matching only via comment.
    const issue = await registry.issues.create({
      repoPath: '/repo',
      title: 'replace the flux capacitor',
      description: 'it drifts',
      startNow: false,
    })
    const commentIssue = await registry.issues.create({
      repoPath: '/repo',
      title: 'unrelated title',
      description: 'nothing relevant',
      startNow: false,
    })
    await registry.issues.addComment(
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
    registry.gateway.routeDaemonFrame('m1', {
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
  it('uses one live-session snapshot and request-local visibility memos', async () => {
    const { store, registry } = await seed()
    const liveRows = await store.sessions.loadSessions()
    const issueRows = await store.issues.listIssueRows()
    const expectedIssueIds = new Set(
      issueRows
        .filter((row) => !row.deletedAt)
        .map((row) => row.id)
        .concat(liveRows.flatMap((row) => (row.issueId ? [row.issueId] : []))),
    )
    const expectedGrantResources = new Set([
      ...issueRows.filter((row) => !row.deletedAt).map((row) => 'issue\0' + row.id),
      ...liveRows.map(
        (row) => (row.issueId ? 'issue' : 'session') + '\0' + (row.issueId ?? row.id),
      ),
    ])

    const loadSessions = store.sessions.loadSessions.bind(store.sessions)
    let loadCalls = 0
    let materializedRows = 0
    store.sessions.loadSessions = async () => {
      loadCalls += 1
      const rows = await loadSessions()
      materializedRows += rows.length
      return rows
    }

    const getIssue = store.issues.getIssue.bind(store.issues)
    let issueLookups = 0
    store.issues.getIssue = async (id) => {
      issueLookups += 1
      return await getIssue(id)
    }

    const listForResource = store.grants.listForResource.bind(store.grants)
    let grantLookups = 0
    store.grants.listForResource = async (resourceKind: string, resourceId: string) => {
      grantLookups += 1
      return await listForResource(resourceKind, resourceId)
    }

    try {
      await registry.modules.memory.search(READER, { text: 'capacitor' })
    } finally {
      store.sessions.loadSessions = loadSessions
      store.issues.getIssue = getIssue
      store.grants.listForResource = listForResource
    }

    // Before batching, each native candidate loaded every live session. The
    // conserved quantity is one snapshot containing exactly the live rows.
    expect(loadCalls).toBe(1)
    expect(materializedRows).toBe(liveRows.length)
    // Each issue and grant resource is read at most once within this request.
    expect(issueLookups).toBe(expectedIssueIds.size)
    expect(grantLookups).toBe(expectedGrantResources.size)
  })

  it('batches issue ownership and grant reads for the native conversation list', async () => {
    const store = await openTestStore(':memory:')
    const registry = await SessionRegistry.create(store, undefined, { instanceId: 'default' })
    registries.push(registry)
    registry.gateway.attachDaemon('m1', () => {})

    const issueIds: string[] = []
    const conversationIds: string[] = []
    const issueOwner = asUserId('usr_issue_owner')
    for (let i = 0; i < 4; i++) {
      const issue = await registry.issues.create({
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

    const getIssue = store.issues.getIssue.bind(store.issues)
    const getIssues = store.issues.getIssues.bind(store.issues)
    const listForResource = store.grants.listForResource.bind(store.grants)
    const listForResources = store.grants.listForResources.bind(store.grants)
    let singleReads = 0
    const batchReads: string[][] = []
    let singleGrantReads = 0
    const batchGrantReads: string[][] = []
    store.issues.getIssue = async (id) => {
      singleReads++
      return await getIssue(id)
    }
    store.issues.getIssues = async (ids) => {
      batchReads.push([...ids])
      return await getIssues(ids)
    }
    store.grants.listForResource = async (kind, id) => {
      if (kind === 'issue') singleGrantReads++
      return await listForResource(kind, id)
    }
    store.grants.listForResources = async (kind, ids) => {
      if (kind === 'issue') batchGrantReads.push([...ids])
      return await listForResources(kind, ids)
    }

    let visible: Awaited<ReturnType<typeof registry.modules.memory.searchConversations>>
    try {
      visible = await registry.modules.memory.searchConversations(READER, { projectPath: '/repo' })
    } finally {
      store.issues.getIssue = getIssue
      store.issues.getIssues = getIssues
      store.grants.listForResource = listForResource
      store.grants.listForResources = listForResources
    }

    expect(visible.map((row) => row.id).sort()).toEqual([...conversationIds].sort())
    // THE DEFECT IS THE CONSERVED SQL COUNT, not a duration: four distinct
    // issue owners still require one live batch and no per-owner statements.
    // Awaiting the binding also lets feed publication prepare visibility for
    // the last fixture issue during this read window. That separate feed batch
    // cannot reuse search's request-local authorization memo: expect two reads,
    // with exactly these inputs, rather than treating it as search fanout.
    expect(singleReads).toBe(0)
    expect(batchReads).toHaveLength(2)
    expect(new Set(batchReads[0])).toEqual(new Set(issueIds))
    expect(batchReads[1]).toEqual([issueIds[3]])
    expect(singleGrantReads).toBe(0)
    expect(batchGrantReads).toHaveLength(1)
    expect(new Set(batchGrantReads[0])).toEqual(new Set(issueIds))
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
    registry.gateway.attachDaemon('m1', () => {})
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
    const issue = await registry.issues.create({
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
    registry.gateway.attachDaemon('m1', () => {})
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
    registry.gateway.attachDaemon(registry.sessionStore.hostMachineId, () => {})
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

/**
 * THE DIRECT CONVERSATION READ — `conversations.search`, not the omni-search above.
 *
 * The census (`packages/commands/src/projections/census.ts`) carried this row as
 * ungoverned on the reading that `modules/conversations/queries.ts:39` hands free
 * text, `projectPath` and a limit to the service with no principal. The principal is
 * there — `modules/conversations/trpc.ts:22` builds the service as
 * `forReader({ kind: 'user', id: caller.userId })` and `search.ts:78` filters every
 * candidate through `mayRead`, which ends at the same owner-or-grant rule
 * (`issue-authz.ts:138`) that `sessions.transcriptRead` applies to the same bytes.
 *
 * What was missing is this file. `search.predicates.test.ts` MOCKS `mayRead`, so it
 * pins the ORDER (filter before limit) and not the rule; the fixture above at
 * 'batches issue ownership and grant reads' uses the real policy but asserts the
 * reader SEES every row, so no refusal is witnessed on this entry point. Deleting
 * the ownership hop therefore left this procedure's own lane green.
 *
 * These tests go through `forReader(...).searchConversations(...)` — the exact
 * construction the tRPC arm uses — rather than the omni-search, because the direct
 * read builds its visibility with `batchIssueOwners: true` (`search.ts:73`) and that
 * priming path is reached from nowhere else.
 *
 * The grant case is not decoration: without it a handler that returned `[]` for
 * everyone but the owner would satisfy both refusals. It pins the decision as
 * owner-OR-GRANT, which is the rule the census row will claim.
 */
describe('conversations.search reader scoping', () => {
  const registries: SessionRegistry[] = []
  afterEach(async () => {
    for (const r of registries.splice(0)) await r.dispose()
  })

  const bob = asUserId('usr_bob_owner')
  const alice = asUserId('usr_alice_stranger')

  /** Bob's conversation, reachable only through the session that resumes it.
   *  Neither identity is the admin member, so no capability short circuit can
   *  decide these cases in place of the policy under test. */
  const seed = async () => {
    const store = await openTestStore(':memory:')
    const registry = await SessionRegistry.create(store, undefined, { instanceId: 'default' })
    registries.push(registry)
    registry.gateway.attachDaemon('m1', () => {})

    const issue = await registry.issues.create({
      repoPath: '/bobrepo',
      title: 'bob private work',
      startNow: false,
      ownerUserId: bob,
    })
    const { sessionId } = await registry.modules.sessions.createSession({
      agentKind: 'claude-code',
      cwd: '/bobrepo/worktree',
      issueId: issue.id,
      ownerUserId: bob,
    })
    await registry.gateway.routeDaemonFrame('m1', {
      type: 'sessionResumeRef',
      sessionId,
      resume: { kind: 'claude-session', value: 'bob-native' },
    })
    await store.conversations.index.upsert([
      {
        id: 'bob-native',
        agentKind: 'claude-code',
        providerId: 'claude-code-jsonl',
        projectPath: '/bobrepo',
        machineId: asMachineId('m1'),
        title: 'ownershipneedle conversation',
      },
    ])
    const searchAs = async (id: UserId, opts: { query?: string; projectPath?: string }) =>
      (await registry.modules.memory.forReader({ kind: 'user', id }).searchConversations(opts)).map(
        (row) => row.id,
      )
    return { store, issue, searchAs }
  }

  it('refuses another member the project-path narrowed read of their conversations', async () => {
    const { searchAs } = await seed()
    // The targeted shape: `projectPath` names one repo/worktree subtree, so a hit
    // reports that work is happening in that checkout and not merely that some
    // conversation matched.
    expect(await searchAs(alice, { projectPath: '/bobrepo' })).toEqual([])
    // COUNTERFACTUAL — without this the empty array above would also be produced by
    // a fixture that indexed nothing.
    expect(await searchAs(bob, { projectPath: '/bobrepo' })).toEqual(['bob-native'])
  })

  it('refuses another member the untargeted free-text trawl of their conversations', async () => {
    const { searchAs } = await seed()
    expect(await searchAs(alice, { query: 'ownershipneedle' })).toEqual([])
    expect(await searchAs(bob, { query: 'ownershipneedle' })).toEqual(['bob-native'])
  })

  it('admits a member the owner granted read on the conversation issue', async () => {
    const { store, issue, searchAs } = await seed()
    expect(await searchAs(alice, { projectPath: '/bobrepo' })).toEqual([])
    await store.grants.upsert({
      resourceKind: 'issue',
      resourceId: issue.id,
      grantee: alice,
      verb: 'read',
      owner: bob,
      visibility: 'personal',
      createdAt: '2026-09-12T00:00:00.000Z',
      actorKind: 'user',
      actorId: bob,
      onBehalfOf: bob,
    })
    expect(await searchAs(alice, { projectPath: '/bobrepo' })).toEqual(['bob-native'])
  })
})
