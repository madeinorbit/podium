import { asIssueId, asUserId, FIRST_ADMIN_USER_ID } from '@podium/model'
import { SearchResultWire } from '@podium/protocol'
import { afterEach, describe, expect, it } from 'vitest'
import { z } from 'zod'
import { resolvePrincipal, userCommandPrincipal } from './command-principal'
import { MEMORY_EXISTENCE_POLICY, MemoryVisibilityPolicy } from './modules/memory/visibility'
import { SuperagentService } from './modules/superagent'
import { SessionRegistry } from './relay'
import { RepoRegistry } from './repo-registry'
import { appRouter } from './router'
import { SessionStore } from './store'
import { OPERATOR } from './test-support/capabilities'

/** The fixture's caller. `addComment` requires a principal (POD-1315) — these
 *  tests exercise the operator seam, so they say so rather than defaulting. */
const AS_OPERATOR = userCommandPrincipal(FIRST_ADMIN_USER_ID, 'admin')

const READER = { kind: 'user' as const, id: FIRST_ADMIN_USER_ID }

// Omni-search (docs/spec/search-v1.md §2.4): one query, ranked typed hits across
// sessions, issues (+comments), conversations, lake-indexed transcripts and the
// settings catalog.

describe('MemoryService omni-search', () => {
  const registries: SessionRegistry[] = []
  afterEach(() => {
    for (const r of registries.splice(0)) r.dispose()
  })

  /** A store + registry seeded with one hit per source for the word "capacitor". */
  function seed() {
    const store = new SessionStore(':memory:')
    const registry = new SessionRegistry(store, undefined, { instanceId: 'default' })
    registries.push(registry)
    registry.gateway.attachDaemon('m1', () => {})

    // Session named after the phrase.
    const { sessionId } = registry.modules.sessions.createSession({
      agentKind: 'claude-code',
      cwd: '/w',
    })
    registry.modules.sessions.renameSession({ sessionId, name: 'capacitor refactor' })
    registry.gateway.routeDaemonFrame('m1', {
      type: 'sessionResumeRef',
      sessionId,
      resume: { kind: 'claude-session', value: 'native-tx' },
    })

    // Issue with the phrase in the title; a second issue matching only via comment.
    const issue = registry.issues.create({
      repoPath: '/repo',
      title: 'replace the flux capacitor',
      description: 'it drifts',
      startNow: false,
    })
    const commentIssue = registry.issues.create({
      repoPath: '/repo',
      title: 'unrelated title',
      description: 'nothing relevant',
      startNow: false,
    })
    registry.issues.addComment(
      commentIssue.id,
      'operator',
      'the capacitor comment trail',
      AS_OPERATOR,
    )

    // Conversation row in the durable index.
    const { sessionId: conversationSessionId } = registry.modules.sessions.createSession({
      ownerUserId: FIRST_ADMIN_USER_ID,
      agentKind: 'claude-code',
      cwd: '/conversation',
    })
    registry.gateway.routeDaemonFrame('m1', {
      type: 'sessionResumeRef',
      sessionId: conversationSessionId,
      resume: { kind: 'claude-session', value: 'native-conv' },
    })
    store.conversations.index.upsert([
      {
        id: 'native-conv',
        agentKind: 'claude-code',
        providerId: 'claude-code-jsonl',
        title: 'capacitor deep dive',
        updatedAt: '2026-07-01T09:00:00.000Z',
        machineId: 'm1',
      },
    ])

    // Lake-indexed transcript messages (what the mirror-fed indexer writes).
    store.conversations.registry.ensure({
      machineId: 'm1',
      nativeId: 'native-tx',
      providerId: 'claude-code-jsonl',
      path: '/home/u/.claude/projects/-w/native-tx.jsonl',
    })
    store.conversations.transcriptIndex.append(
      'm1',
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

  it('returns typed hits from every matching source in one call', () => {
    const { store, registry, sessionId, issue, commentIssue } = seed()
    const results = registry.modules.memory.search(READER, { text: 'capacitor' })

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

  it('ranks sanely: title-matching session/issue above the transcript hit', () => {
    const { store, registry } = seed()
    const results = registry.modules.memory.search(READER, { text: 'capacitor' })
    const rank = (kind: string) => results.findIndex((r) => r.kind === kind)
    expect(rank('session')).toBeGreaterThanOrEqual(0)
    expect(rank('transcript')).toBeGreaterThanOrEqual(0)
    expect(rank('session')).toBeLessThan(rank('transcript'))
    const titleIssue = results.findIndex((r) => r.kind === 'issue' && r.title.includes('flux'))
    expect(titleIssue).toBeLessThan(rank('transcript'))
  })

  it('transcript hits carry an FTS snippet with match markers and registry refs', () => {
    const { store, registry } = seed()
    const hit = registry.modules.memory
      .search(READER, { text: 'capacitor' })
      .find((r) => r.kind === 'transcript')
    expect(hit?.snippet).toContain('**capacitor**')
    expect(hit?.machineId).toBe('m1')
    expect(hit?.podiumId).toMatch(/^conv_/)
  })

  it('resolves a live sessionId on a transcript hit when a session resumes that native id', () => {
    const { registry, sessionId } = seed()
    const hit = registry.modules.memory
      .search(READER, { text: 'engine.ts' })
      .find((r) => r.kind === 'transcript')
    expect(hit?.sessionId).toBe(sessionId)
  })

  it('matches the settings catalog by label', () => {
    const { store, registry } = seed()
    const results = registry.modules.memory.search(READER, { text: 'notifications' })
    const setting = results.find((r) => r.kind === 'setting')
    expect(setting?.settingKey).toBe('notifications')
    expect(setting?.title).toBe('Settings › Notifications')
  })

  it('respects the limit across the fused list', () => {
    const { store, registry } = seed()
    const results = registry.modules.memory.search(READER, { text: 'capacitor', limit: 2 })
    expect(results.length).toBe(2)
    // The limit trims the tail, not the head: the best hits survive.
    expect(results[0]?.score).toBeGreaterThanOrEqual(results[1]?.score ?? 0)
  })
  it('uses one live-session snapshot and request-local visibility memos', () => {
    const { store, registry } = seed()
    const liveRows = store.sessions.loadSessions()
    const issueRows = store.issues.listIssueRows()
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
    store.sessions.loadSessions = () => {
      loadCalls += 1
      const rows = loadSessions()
      materializedRows += rows.length
      return rows
    }

    const getIssue = store.issues.getIssue.bind(store.issues)
    let issueLookups = 0
    store.issues.getIssue = (id) => {
      issueLookups += 1
      return getIssue(id)
    }

    const listForResource = store.grants.listForResource.bind(store.grants)
    let grantLookups = 0
    store.grants.listForResource = (resourceKind: string, resourceId: string) => {
      grantLookups += 1
      return listForResource(resourceKind, resourceId)
    }

    try {
      registry.modules.memory.search(READER, { text: 'capacitor' })
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

  it('batches issue ownership reads for the native conversation list', () => {
    const store = new SessionStore(':memory:')
    const registry = new SessionRegistry(store, undefined, { instanceId: 'default' })
    registries.push(registry)
    registry.gateway.attachDaemon('m1', () => {})

    const issueIds: string[] = []
    const conversationIds: string[] = []
    for (let i = 0; i < 4; i++) {
      const issue = registry.issues.create({
        repoPath: '/repo',
        title: `conversation issue ${i}`,
        startNow: false,
      })
      issueIds.push(issue.id)
      const { sessionId } = registry.modules.sessions.createSession({
        agentKind: 'claude-code',
        cwd: `/repo/session-${i}`,
        issueId: issue.id,
      })
      const nativeId = `native-conversation-${i}`
      conversationIds.push(nativeId)
      registry.gateway.routeDaemonFrame('m1', {
        type: 'sessionResumeRef',
        sessionId,
        resume: { kind: 'claude-session', value: nativeId },
      })
      store.conversations.index.upsert([
        {
          id: nativeId,
          agentKind: 'claude-code',
          providerId: 'claude-code-jsonl',
          projectPath: '/repo',
          machineId: 'm1',
        },
      ])
    }

    const getIssue = store.issues.getIssue.bind(store.issues)
    const getIssues = store.issues.getIssues.bind(store.issues)
    let singleReads = 0
    const batchReads: string[][] = []
    store.issues.getIssue = (id) => {
      singleReads++
      return getIssue(id)
    }
    store.issues.getIssues = (ids) => {
      batchReads.push([...ids])
      return getIssues(ids)
    }

    let visible: ReturnType<typeof registry.modules.memory.searchConversations>
    try {
      visible = registry.modules.memory.searchConversations(READER, { projectPath: '/repo' })
    } finally {
      store.issues.getIssue = getIssue
      store.issues.getIssues = getIssues
    }

    expect(visible.map((row) => row.id).sort()).toEqual([...conversationIds].sort())
    // THE DEFECT IS THE CONSERVED SQL COUNT, not a duration: four distinct
    // issue owners still require one live batch and no per-owner statements.
    expect(singleReads).toBe(0)
    expect(batchReads).toHaveLength(1)
    expect(new Set(batchReads[0])).toEqual(new Set(issueIds))
  })

  it('returns nothing for blank text (the router schema rejects it upstream too)', () => {
    const { store, registry } = seed()
    expect(registry.modules.memory.search(READER, { text: '   ' })).toEqual([])
  })
})

describe('search.query tRPC', () => {
  const registries: SessionRegistry[] = []
  afterEach(() => {
    for (const r of registries.splice(0)) r.dispose()
  })

  it('excludes every private memory source owned by another user', () => {
    const store = new SessionStore(':memory:')
    const registry = new SessionRegistry(store, undefined, { instanceId: 'default' })
    registries.push(registry)
    registry.gateway.attachDaemon('m1', () => {})
    const bob = asUserId('usr_bob')
    const { sessionId } = registry.modules.sessions.createSession({
      ownerUserId: bob,
      agentKind: 'claude-code',
      cwd: '/classifiedneedle',
    })
    registry.modules.sessions.renameSession({ sessionId, name: 'classifiedneedle session' })
    registry.gateway.routeDaemonFrame('m1', {
      type: 'sessionResumeRef',
      sessionId,
      resume: { kind: 'claude-session', value: 'classified-native' },
    })
    store.conversations.index.upsert([
      {
        id: 'classified-native',
        agentKind: 'claude-code',
        providerId: 'claude-code-jsonl',
        machineId: 'm1',
        title: 'classifiedneedle conversation',
      },
    ])
    store.conversations.transcriptIndex.append(
      'm1',
      'classified-native',
      [
        {
          content: 'classifiedneedle transcript',
          itemUuid: 'private-message',
        },
      ],
      100,
    )
    const issue = registry.issues.create({
      repoPath: '/private',
      title: 'fixture template',
      description: 'private issue body',
      startNow: false,
    })
    const issueRow = store.issues.getIssue(issue.id)
    if (!issueRow) throw new Error('issue seed missing')
    store.issues.upsertIssue({
      ...issueRow,
      id: asIssueId('iss_bob_private'),
      seq: issueRow.seq + 1,
      ownerUserId: bob,
      title: 'classifiedneedle issue',
    })
    store.superagent.upsertSuperagentThread({
      id: 'private-thread',
      ownerUserId: bob,
      kind: 'btw',
      title: 'classifiedneedle superagent',
    })
    store.superagent.appendSuperagentMessage('private-thread', {
      role: 'assistant',
      content: 'classifiedneedle private thread body',
    })

    expect(registry.modules.memory.search(READER, { text: 'classifiedneedle' })).toEqual([])
    const bobHits = registry.modules.memory.search(
      { kind: 'user', id: bob },
      { text: 'classifiedneedle' },
    )
    expect(new Set(bobHits.map((hit) => hit.kind))).toEqual(
      new Set(['session', 'issue', 'conversation', 'transcript']),
    )
    expect(bobHits.some((hit) => hit.id === 'superagent:private-thread')).toBe(true)
  })

  it('filters hidden transcript ranks before normalizing visible results', () => {
    const store = new SessionStore(':memory:')
    const registry = new SessionRegistry(store, undefined, { instanceId: 'default' })
    registries.push(registry)
    registry.gateway.attachDaemon('m1', () => {})
    const bob = asUserId('usr_bob')
    const bind = (ownerUserId: typeof bob, nativeId: string, cwd: string) => {
      const { sessionId } = registry.modules.sessions.createSession({
        ownerUserId,
        agentKind: 'claude-code',
        cwd,
      })
      registry.gateway.routeDaemonFrame('m1', {
        type: 'sessionResumeRef',
        sessionId,
        resume: { kind: 'claude-session', value: nativeId },
      })
    }
    bind(FIRST_ADMIN_USER_ID, 'visible-rank', '/visible')
    store.conversations.transcriptIndex.append(
      'm1',
      'visible-rank',
      [
        {
          content: 'rankneedle visible',
          itemUuid: 'visible-rank-message',
        },
      ],
      100,
    )
    const before = registry.modules.memory
      .search(READER, { text: 'rankneedle' })
      .find((hit) => hit.kind === 'transcript')
    bind(bob, 'hidden-rank', '/hidden')
    store.conversations.transcriptIndex.append(
      'm1',
      'hidden-rank',
      [
        {
          content: 'rankneedle rankneedle rankneedle rankneedle',
          itemUuid: 'hidden-rank-message',
        },
      ],
      100,
    )
    const after = registry.modules.memory
      .search(READER, { text: 'rankneedle' })
      .find((hit) => hit.kind === 'transcript')
    expect(after?.id).toBe(before?.id)
    expect(after?.score).toBe(before?.score)
  })

  it('defaults unknown memory classes closed and counts to the visible slice', () => {
    const store = new SessionStore(':memory:')
    expect(new MemoryVisibilityPolicy(store).mayRead(READER, { class: 'future-kind' })).toBe(false)
    expect(MEMORY_EXISTENCE_POLICY).toEqual({ counts: 'visible-slice', facets: 'visible-slice' })
    store.close()
  })

  function caller() {
    const registry = new SessionRegistry(undefined, undefined, { instanceId: 'default' })
    registries.push(registry)
    registry.gateway.attachDaemon(registry.sessionStore.hostMachineId, () => {})
    const repos = new RepoRegistry(registry, registry.sessionStore)
    const superagent = new SuperagentService(registry.modules, repos, registry.sessionStore)
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
    const { trpc } = caller()
    await expect(trpc.search.query({ text: '' })).rejects.toThrow()
  })

  it('serves ranked results over the wire shape', async () => {
    const { registry, trpc } = caller()
    const { sessionId } = registry.modules.sessions.createSession({
      agentKind: 'claude-code',
      cwd: '/w',
    })
    registry.modules.sessions.renameSession({ sessionId, name: 'quantum toaster' })
    const results = await trpc.search.query({ text: 'quantum' })
    expect(results.map((r) => SearchResultWire.parse(r))).toHaveLength(1)
    expect(results[0]?.sessionId).toBe(sessionId)
  })
})
