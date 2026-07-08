import { SearchResultWire } from '@podium/protocol'
import { afterEach, describe, expect, it } from 'vitest'
import { z } from 'zod'
import { OPERATOR } from './issue-authz'
import { SessionRegistry } from './relay'
import { RepoRegistry } from './repo-registry'
import { appRouter } from './router'
import { searchAll } from './search'
import { SessionStore } from './store'
import { SuperagentService } from './modules/superagent'

// Omni-search (docs/spec/search-v1.md §2.4): one query, ranked typed hits across
// sessions, issues (+comments), conversations, lake-indexed transcripts and the
// settings catalog.

describe('searchAll', () => {
  const registries: SessionRegistry[] = []
  afterEach(() => {
    for (const r of registries.splice(0)) r.dispose()
  })

  /** A store + registry seeded with one hit per source for the word "capacitor". */
  function seed() {
    const store = new SessionStore(':memory:')
    const registry = new SessionRegistry(store)
    registries.push(registry)
    registry.attachDaemon('m1', () => {})

    // Session named after the phrase.
    const { sessionId } = registry.createSession({ agentKind: 'claude-code', cwd: '/w' })
    registry.renameSession({ sessionId, name: 'capacitor refactor' })

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
    registry.issues.addComment(commentIssue.id, 'operator', 'the capacitor comment trail')

    // Conversation row in the durable index.
    store.conversations.upsertConversations([
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
    store.conversations.ensureConversationIdentity({
      machineId: 'm1',
      nativeId: 'native-tx',
      providerId: 'claude-code-jsonl',
      path: '/home/u/.claude/projects/-w/native-tx.jsonl',
    })
    store.conversations.appendTranscriptIndex(
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
    const results = searchAll(store, registry, { text: 'capacitor' })

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
    const results = searchAll(store, registry, { text: 'capacitor' })
    const rank = (kind: string) => results.findIndex((r) => r.kind === kind)
    expect(rank('session')).toBeGreaterThanOrEqual(0)
    expect(rank('transcript')).toBeGreaterThanOrEqual(0)
    expect(rank('session')).toBeLessThan(rank('transcript'))
    const titleIssue = results.findIndex((r) => r.kind === 'issue' && r.title.includes('flux'))
    expect(titleIssue).toBeLessThan(rank('transcript'))
  })

  it('transcript hits carry an FTS snippet with match markers and registry refs', () => {
    const { store, registry } = seed()
    const hit = searchAll(store, registry, { text: 'capacitor' }).find(
      (r) => r.kind === 'transcript',
    )
    expect(hit?.snippet).toContain('**capacitor**')
    expect(hit?.machineId).toBe('m1')
    expect(hit?.podiumId).toMatch(/^conv_/)
  })

  it('resolves a live sessionId on a transcript hit when a session resumes that native id', () => {
    const { store, registry } = seed()
    const { sessionId } = registry.createSession({ agentKind: 'claude-code', cwd: '/w' })
    registry.onDaemonMessageFrom('m1', {
      type: 'sessionResumeRef',
      sessionId,
      resume: { kind: 'claude-session', value: 'native-tx' },
    })
    const hit = searchAll(store, registry, { text: 'engine.ts' }).find(
      (r) => r.kind === 'transcript',
    )
    expect(hit?.sessionId).toBe(sessionId)
  })

  it('matches the settings catalog by label', () => {
    const { store, registry } = seed()
    const results = searchAll(store, registry, { text: 'notifications' })
    const setting = results.find((r) => r.kind === 'setting')
    expect(setting?.settingKey).toBe('notifications')
    expect(setting?.title).toBe('Settings › Notifications')
  })

  it('respects the limit across the fused list', () => {
    const { store, registry } = seed()
    const results = searchAll(store, registry, { text: 'capacitor', limit: 2 })
    expect(results.length).toBe(2)
    // The limit trims the tail, not the head: the best hits survive.
    expect(results[0]?.score).toBeGreaterThanOrEqual(results[1]?.score ?? 0)
  })

  it('returns nothing for blank text (the router schema rejects it upstream too)', () => {
    const { store, registry } = seed()
    expect(searchAll(store, registry, { text: '   ' })).toEqual([])
  })
})

describe('search.query tRPC', () => {
  const registries: SessionRegistry[] = []
  afterEach(() => {
    for (const r of registries.splice(0)) r.dispose()
  })

  function caller() {
    const registry = new SessionRegistry()
    registries.push(registry)
    registry.attachDaemon('local', () => {})
    const repos = new RepoRegistry(registry, registry.sessionStore)
    const superagent = new SuperagentService(registry.modules, repos, registry.sessionStore)
    return {
      registry,
      trpc: appRouter.createCaller({ registry, repos, superagent, capability: OPERATOR }),
    }
  }

  it('rejects empty text at the schema', async () => {
    const { trpc } = caller()
    await expect(trpc.search.query({ text: '' })).rejects.toThrow()
  })

  it('serves ranked results over the wire shape', async () => {
    const { registry, trpc } = caller()
    const { sessionId } = registry.createSession({ agentKind: 'claude-code', cwd: '/w' })
    registry.renameSession({ sessionId, name: 'quantum toaster' })
    const results = await trpc.search.query({ text: 'quantum' })
    expect(results.map((r) => SearchResultWire.parse(r))).toHaveLength(1)
    expect(results[0]?.sessionId).toBe(sessionId)
  })
})
