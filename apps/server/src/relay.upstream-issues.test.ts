import type { IssueWire, ServerMessage } from '@podium/protocol'
import { describe, expect, it, vi } from 'vitest'
import type { IssueUpstreamForwarder } from './relay'
import { SessionRegistry } from './relay'
import { SessionStore } from './store'

// Registry-level tests for the upstream ISSUE mirror + write forwarding
// (docs/spec/node-hub-issues.md): local ∪ upstream in every issue wire seam,
// viaHub stamping, id-collision guard (local wins), IssueService store purity,
// staleness at read time, optimistic pendingSync patches + hub-truth overwrite,
// and no-upstream inertness.

function hubIssue(id: string, over: Partial<IssueWire> = {}): IssueWire {
  return {
    id,
    repoPath: '/hub/repo',
    seq: 1,
    title: `hub ${id}`,
    description: '',
    stage: 'backlog',
    worktreePath: null,
    branch: null,
    parentBranch: 'main',
    defaultAgent: 'claude-code',
    defaultModel: 'auto',
    defaultEffort: 'auto',
    blockedBy: [],
    priority: 2,
    type: 'task',
    pinned: false,
    needsHuman: false,
    labels: [],
    deps: [],
    dependents: [],
    comments: [],
    ready: true,
    blocked: false,
    deferred: false,
    childCount: 0,
    childDoneCount: 0,
    createdAt: '2026-07-01T00:00:00.000Z',
    updatedAt: '2026-07-01T00:00:00.000Z',
    archived: false,
    readAt: null,
    unread: false,
    origin: 'human' as const,
    audience: 'human' as const,
    draft: false,
    sessions: [],
    sessionSummary: { total: 0, byPhase: {} },
    ...over,
  }
}

function makeNode() {
  const store = new SessionStore(':memory:')
  const registry = new SessionRegistry(store)
  registry.attachDaemon('local', () => {})
  return { store, registry }
}

/** A scripted stand-in for UpstreamForwarder: every forward "queues". */
function stubForwarder(): IssueUpstreamForwarder & {
  clear(): void
  forwarded: { proc: string; input: Record<string, unknown> }[]
} {
  const rows: { mutationId: string; proc: string; input: string; attempts: number }[] = []
  const forwarded: { proc: string; input: Record<string, unknown> }[] = []
  return {
    forwarded,
    async forward(proc, input) {
      forwarded.push({ proc, input })
      rows.push({
        mutationId: String(input.mutationId),
        proc,
        input: JSON.stringify(input),
        attempts: 0,
      })
      return { queued: true }
    },
    entries: () => rows,
    clear: () => {
      rows.length = 0
    },
  }
}

/** The issue list a fresh client sees on attach (the wire's bootstrap snapshot). */
function attachIssues(registry: SessionRegistry): IssueWire[] {
  const inbox: ServerMessage[] = []
  registry.attachClient((m) => inbox.push(m))
  const msg = inbox.find((m) => m.type === 'issuesChanged')
  return msg?.type === 'issuesChanged' ? msg.issues : []
}

describe('upstream issue mirror (wire union, spec §2.1)', () => {
  it('hub issues merge into attach snapshots + changesSince, viaHub-stamped; local issues unmarked', async () => {
    const { registry } = makeNode()
    const local = await registry.issues.createAndMaybeStart({
      repoPath: '/local/repo',
      title: 'local issue',
      startNow: false,
    })
    registry.setUpstreamIssues([hubIssue('iss_hub1')])

    for (const issues of [
      attachIssues(registry),
      (() => {
        const snap = registry.syncChangesSince(null)
        return snap.kind === 'snapshot' ? snap.issues : []
      })(),
    ]) {
      expect(issues.map((i) => i.id).sort()).toEqual([local.id, 'iss_hub1'].sort())
      expect(issues.find((i) => i.id === 'iss_hub1')?.viaHub).toBe(true)
      expect(issues.find((i) => i.id === local.id)?.viaHub).toBeUndefined()
    }
  })

  it('issuesChanged broadcasts carry the union (IssueService fan-outs included)', async () => {
    const { registry } = makeNode()
    registry.setUpstreamIssues([hubIssue('iss_hub1')])
    const inbox: ServerMessage[] = []
    registry.attachClient((m) => inbox.push(m))
    inbox.length = 0
    // A LOCAL mutation broadcast must still include the mirrored hub issue.
    await registry.issues.createAndMaybeStart({
      repoPath: '/local/repo',
      title: 'later local',
      startNow: false,
    })
    const msg = inbox.filter((m) => m.type === 'issuesChanged').pop()
    expect(msg).toBeDefined()
    if (msg?.type !== 'issuesChanged') return
    expect(msg.issues.some((i) => i.id === 'iss_hub1' && i.viaHub)).toBe(true)
    expect(msg.issues.some((i) => i.title === 'later local' && !i.viaHub)).toBe(true)
  })

  it("IssueService's store never contains upstream rows (invariant 1)", () => {
    const { registry, store } = makeNode()
    registry.setUpstreamIssues([hubIssue('iss_hub1')])
    // The node's own tracker — what the assistant/steward layers read — is empty:
    // upstream rows exist on the WIRE only, so no autonomous node-side flow
    // (steward triggers, assistant timers) can ever act on a viaHub issue.
    expect(registry.issues.allWire()).toHaveLength(0)
    expect(store.listIssueRows()).toHaveLength(0)
    expect(registry.issues.get('iss_hub1')).toBeNull()
  })

  it('id collision: the local issue wins, the anomaly is logged', async () => {
    const { registry } = makeNode()
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const local = await registry.issues.createAndMaybeStart({
        repoPath: '/local/repo',
        title: 'mine',
        startNow: false,
      })
      registry.setUpstreamIssues([hubIssue(local.id, { title: 'impostor' })])
      const issues = attachIssues(registry)
      expect(issues.filter((i) => i.id === local.id)).toHaveLength(1)
      expect(issues.find((i) => i.id === local.id)?.title).toBe('mine')
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('collides'))
    } finally {
      warn.mockRestore()
    }
  })

  it('hub loss: mirrored issues stale-flagged at read time, retained; link back clears', () => {
    const { registry } = makeNode()
    registry.setUpstreamIssues([hubIssue('iss_hub1')])
    registry.setUpstreamStale(true)
    let entry = attachIssues(registry).find((i) => i.id === 'iss_hub1')
    expect(entry).toBeDefined() // retained, never blanked
    expect(entry?.upstreamStale).toBe(true)
    registry.setUpstreamStale(false)
    entry = attachIssues(registry).find((i) => i.id === 'iss_hub1')
    expect(entry?.upstreamStale).toBeUndefined()
  })

  it('re-ingest replaces the mirror (an issue gone from the hub disappears)', () => {
    const { registry } = makeNode()
    registry.setUpstreamIssues([hubIssue('iss_hub1'), hubIssue('iss_hub2')])
    registry.setUpstreamIssues([hubIssue('iss_hub2')])
    const ids = attachIssues(registry).map((i) => i.id)
    expect(ids).not.toContain('iss_hub1')
    expect(ids).toContain('iss_hub2')
  })
})

describe('upstream issue write forwarding (spec §2.2)', () => {
  it('a queued forward optimistically patches the replica entry with pendingSync', async () => {
    const { registry } = makeNode()
    const fwd = stubForwarder()
    registry.setUpstreamForwarder(fwd)
    registry.setUpstreamIssues([hubIssue('iss_hub1')])

    const res = await registry.forwardIssueMutation('update', {
      id: 'iss_hub1',
      patch: { title: 'edited offline' },
    })
    expect(res).toEqual({ queued: true })
    // The forward carried a minted mutationId (invariant 2: every forwarded
    // mutation carries one).
    expect(typeof fwd.forwarded[0]?.input.mutationId).toBe('string')

    const entry = attachIssues(registry).find((i) => i.id === 'iss_hub1')
    expect(entry?.title).toBe('edited offline')
    expect(entry?.pendingSync).toBe(true)
    expect(entry?.viaHub).toBe(true)
  })

  // #175: comment bodies no longer ride IssueWire — a queued addComment's
  // optimistic effect is a commentCount bump (the body surfaces via the hub).
  it('addComment queues an optimistic commentCount bump', async () => {
    const { registry } = makeNode()
    registry.setUpstreamForwarder(stubForwarder())
    registry.setUpstreamIssues([hubIssue('iss_hub1')])
    await registry.forwardIssueMutation('addComment', {
      id: 'iss_hub1',
      author: 'operator',
      body: 'note from the node',
    })
    const entry = attachIssues(registry).find((i) => i.id === 'iss_hub1')
    expect(entry?.pendingSync).toBe(true)
    expect(entry?.commentCount).toBe(1)
    expect(JSON.stringify(entry)).not.toContain('note from the node')
  })

  it('a hub push while the edit is STILL queued keeps the optimistic patch', async () => {
    const { registry } = makeNode()
    const fwd = stubForwarder()
    registry.setUpstreamForwarder(fwd)
    registry.setUpstreamIssues([hubIssue('iss_hub1')])
    await registry.forwardIssueMutation('update', { id: 'iss_hub1', patch: { title: 'edited' } })
    // Reconnect heal delivers PRE-mutation truth (drain hasn't applied yet).
    registry.setUpstreamIssues([hubIssue('iss_hub1')])
    const entry = attachIssues(registry).find((i) => i.id === 'iss_hub1')
    expect(entry?.title).toBe('edited') // replica doesn't argue, but the queued edit stays visible
    expect(entry?.pendingSync).toBe(true)
  })

  it('hub truth after the outbox drained overwrites the patch and clears pendingSync', async () => {
    const { registry } = makeNode()
    const fwd = stubForwarder()
    registry.setUpstreamForwarder(fwd)
    registry.setUpstreamIssues([hubIssue('iss_hub1')])
    await registry.forwardIssueMutation('update', { id: 'iss_hub1', patch: { title: 'edited' } })
    fwd.clear() // the drain applied the entry hub-side
    registry.upstreamOutboxChanged()
    // …and the hub's delta delivers post-mutation truth.
    registry.setUpstreamIssues([hubIssue('iss_hub1', { title: 'edited', description: 'hub says' })])
    const entry = attachIssues(registry).find((i) => i.id === 'iss_hub1')
    expect(entry?.title).toBe('edited')
    expect(entry?.description).toBe('hub says')
    expect(entry?.pendingSync).toBeUndefined()
  })

  it('a hub-rejected queued mutation is surfaced: overlay retired + durable event + needsHuman marker (#25)', async () => {
    const { registry, store } = makeNode()
    const fwd = stubForwarder()
    registry.setUpstreamForwarder(fwd)
    registry.setUpstreamIssues([hubIssue('iss_hub1')])
    // The edit queues (hub unreachable) and shows optimistically.
    await registry.forwardIssueMutation('update', {
      id: 'iss_hub1',
      patch: { title: 'edit the hub refuses' },
    })
    expect(attachIssues(registry).find((i) => i.id === 'iss_hub1')?.title).toBe(
      'edit the hub refuses',
    )
    const mutationId = String(fwd.forwarded[0]?.input.mutationId)
    // The hub comes back and definitively rejects the queued entry (simulated 400):
    // the forwarder drops it and fires onPoisoned → upstreamMutationRejected.
    fwd.clear()
    registry.upstreamMutationRejected(
      'update',
      { id: 'iss_hub1', patch: { title: 'edit the hub refuses' }, mutationId },
      'BAD_REQUEST: title rejected',
    )
    registry.upstreamOutboxChanged() // the forwarder's onQueueChanged follows onPoisoned
    const entry = attachIssues(registry).find((i) => i.id === 'iss_hub1')
    // The lost edit no longer shows — the overlay was retired immediately.
    expect(entry?.title).toBe('hub iss_hub1')
    // The loss is visible on the issue…
    expect(entry?.needsHuman).toBe(true)
    expect(entry?.humanQuestion).toContain('BAD_REQUEST: title rejected')
    // …and durably recorded as a podium event.
    const events = store.listEventsSince(0).filter((e) => e.kind === 'issue.upstream_rejected')
    expect(events).toHaveLength(1)
    expect(events[0]?.subject).toBe('iss_hub1')
    expect(events[0]?.payload).toMatchObject({
      proc: 'update',
      mutationId,
      message: 'BAD_REQUEST: title rejected',
    })
    // The next hub truth push clears the marker (the event remains the audit trail).
    registry.setUpstreamIssues([hubIssue('iss_hub1')])
    const healed = attachIssues(registry).find((i) => i.id === 'iss_hub1')
    expect(healed?.needsHuman).toBe(false)
    expect(healed?.pendingSync).toBeUndefined()
  })

  it('pendingSync flips hit the live wire (clients see the queue state without re-attach)', async () => {
    const { registry } = makeNode()
    const fwd = stubForwarder()
    registry.setUpstreamForwarder(fwd)
    registry.setUpstreamIssues([hubIssue('iss_hub1')])
    const inbox: ServerMessage[] = []
    registry.attachClient((m) => inbox.push(m))
    inbox.length = 0
    await registry.forwardIssueMutation('close', { id: 'iss_hub1' })
    const afterQueue = inbox.filter((m) => m.type === 'issuesChanged').pop()
    if (afterQueue?.type !== 'issuesChanged') throw new Error('no issuesChanged after queue')
    expect(afterQueue.issues.find((i) => i.id === 'iss_hub1')?.pendingSync).toBe(true)
    expect(afterQueue.issues.find((i) => i.id === 'iss_hub1')?.stage).toBe('done')
  })
})

describe('no-upstream inertness (invariant 4)', () => {
  it('without upstream state, issue seams behave exactly as before', async () => {
    const { registry, store } = makeNode()
    const local = await registry.issues.createAndMaybeStart({
      repoPath: '/local/repo',
      title: 'plain',
      startNow: false,
    })
    expect(registry.isUpstreamIssue(local.id)).toBe(false)
    expect(registry.upstreamIssueRepoPaths().size).toBe(0)
    const issues = attachIssues(registry)
    expect(issues.map((i) => i.id)).toEqual([local.id])
    expect(issues[0]?.viaHub).toBeUndefined()
    // No forwarder configured → forwarding is a hard error, never a silent queue.
    await expect(registry.forwardIssueMutation('update', { id: 'x', patch: {} })).rejects.toThrow(
      /no upstream/,
    )
    expect(store.listUpstreamOutbox()).toHaveLength(0)
  })
})
