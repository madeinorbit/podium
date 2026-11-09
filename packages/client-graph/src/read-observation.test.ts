import { asIssueId, asSessionId } from '@podium/model'
import { autorun } from 'mobx'
import { afterEach, expect, it, vi } from 'vitest'
import { Reactions } from '../../client-core/src/engine/reactions'
import {
  READ_CHECKPOINT_MS,
  READ_SETTLE_MS,
} from '../../client-core/src/engine/read-acknowledgements'
import type { RuntimeState } from '../../client-core/src/engine/state'
import { createPoolNavigationProvider } from './navigation-provider'
import { MobxPool } from './pool'
import { worklistView } from './worklist/view-model'

afterEach(() => vi.useRealTimers())

const base = Date.parse('2026-10-29T12:00:00.000Z')
const stamp = (offset = 0) => new Date(base + offset).toISOString()

function fixture() {
  vi.useFakeTimers()
  vi.setSystemTime(base)
  const pool = new MobxPool({ selectedIssueId: 'root', coarseNow: base })
  let activity = stamp()
  let issueReadAt: string | null = null
  let sessionReadAt: string | null = null
  const issue = (id: string) => ({
    id,
    seq: 1,
    title: id,
    stage: 'in_progress',
    audience: 'human',
    repoPath: '/synthetic',
    createdAt: stamp(),
    updatedAt: activity,
    readAt: id === 'root' ? issueReadAt : null,
    ...(id === 'child' ? { parentId: 'root' } : {}),
  })
  const session = (id: string) => ({
    sessionId: id,
    issueId: 'root',
    cwd: '/synthetic',
    agentKind: 'codex',
    status: 'live',
    lastActiveAt: activity,
    archived: false,
    unread: id === 'seat' ? !sessionReadAt || sessionReadAt < activity : true,
    readAt: id === 'seat' ? sessionReadAt : null,
    agentState: { phase: 'working', since: stamp() },
  })
  const paint = () =>
    pool.apply({
      type: 'update',
      rows: [
        ...['root', 'child'].map((id) => ({
          kind: 'issue' as const,
          id,
          value: issue(id) as never,
        })),
        ...['seat', 'other'].map((id) => ({
          kind: 'session' as const,
          id,
          value: session(id) as never,
        })),
      ],
    })
  paint()
  const navigation = createPoolNavigationProvider(pool)
  const state = {
    navigation,
    view: 'workspace',
    selectedIssueId: asIssueId('root'),
    selectedWorktree: null,
    workspaces: {},
    paneA: asSessionId('seat'),
    paneB: null,
    split: false,
    focusedPane: 'A',
    fileTabs: [],
    panelMode: {},
    issueVisitBaseline: null,
  } as unknown as RuntimeState
  let visible = true
  const markIssueRead = vi.fn((_id: string, at: string) => {
    issueReadAt = at
    paint()
  })
  const markSessionRead = vi.fn((_id: string, at: string) => {
    sessionReadAt = at
    paint()
  })
  const reactions = new Reactions({
    state: () => state,
    publish: (patch) => Object.assign(state, patch),
    hub: { setVisible() {}, setViewState() {} } as never,
    notices: {} as never,
    isVisible: () => visible,
    markIssueRead,
    markSessionRead,
  })
  const update = () => {
    reactions.updateIssueMarkReadTimer()
    reactions.updateMarkReadTimer()
  }
  return {
    pool,
    state,
    navigation,
    reactions,
    update,
    markIssueRead,
    markSessionRead,
    activity(offset: number) {
      activity = stamp(offset)
      paint()
      update()
    },
    visible(value: boolean) {
      visible = value
      reactions.onVisibilityChange()
    },
    unread(kind: 'issue' | 'session') {
      if (!navigation.readIntent) throw new Error('read intent port missing')
      navigation.readIntent(kind, kind === 'issue' ? 'root' : 'seat', false)
      if (kind === 'issue') issueReadAt = null
      else sessionReadAt = null
      paint()
    },
    close() {
      reactions.dispose()
      pool.dispose()
    },
  }
}

it('waits for leading and final local enqueues before allowing reload', async () => {
  const f = fixture()
  const releases: Array<() => void> = []
  f.markIssueRead.mockImplementation(() => new Promise<void>((resolve) => releases.push(resolve)))
  try {
    f.update()
    f.activity(100)
    let durable = false
    const saving = f.reactions.flushReadAcknowledgements().then(() => {
      durable = true
    })
    await Promise.resolve()
    expect(releases).toHaveLength(2)
    expect(durable).toBe(false)
    releases[0]?.()
    await Promise.resolve()
    expect(durable).toBe(false)
    releases[1]?.()
    await saving
    expect(durable).toBe(true)
  } finally {
    f.close()
  }
})

it('cancels a pending receipt when manual unread arrives without another activity update', () => {
  const f = fixture()
  try {
    f.update()
    f.activity(100)
    f.unread('issue')
    vi.advanceTimersByTime(READ_CHECKPOINT_MS)
    expect(f.markIssueRead).toHaveBeenCalledTimes(1)
    expect(f.pool.issueObject('root').unread).toBe(true)
    f.reactions.leaveReadVisits()
    expect(f.markIssueRead).toHaveBeenCalledTimes(1)
    expect(f.pool.issueObject('root').readObservation.viewing).toBe(false)
  } finally {
    f.close()
  }
})

it('keeps visible content seen through 600 updates with bounded receipts and a trailing save', () => {
  const f = fixture()
  const changes: boolean[] = []
  const stop = autorun(() => {
    changes.push(worklistView(f.pool).row(f.pool.issueObject('root')).visibleUnread)
  })
  try {
    const unread: boolean[] = []
    for (let offset = 0; offset < 60_000; offset += 100) {
      vi.advanceTimersByTime(offset === 0 ? 0 : 100)
      f.activity(offset)
      unread.push(f.pool.issueObject('root').unread)
      expect(f.pool.sessionObject('seat').unread).toBe(false)
    }
    expect(unread.every((value) => !value)).toBe(true)
    expect(changes).toEqual([true, false])
    expect(f.markIssueRead).toHaveBeenCalledTimes(6)
    expect(f.markSessionRead).toHaveBeenCalledTimes(6)
    expect(f.pool.issueObject('child').unread).toBe(true)
    expect(f.pool.sessionObject('other').unread).toBe(true)
    vi.advanceTimersByTime(READ_SETTLE_MS)
    expect(f.markIssueRead).toHaveBeenCalledTimes(7)
    expect(f.markSessionRead).toHaveBeenCalledTimes(7)
    expect(f.markIssueRead.mock.calls.at(-1)?.[1]).toBe(stamp(59_900))
    vi.advanceTimersByTime(READ_CHECKPOINT_MS)
    expect(f.markIssueRead).toHaveBeenCalledTimes(7)
  } finally {
    stop()
    f.close()
  }
})

it('flushes only seen activity on backgrounding and acknowledges new activity on return', () => {
  const f = fixture()
  try {
    f.update()
    vi.advanceTimersByTime(100)
    f.activity(100)
    f.visible(false)
    expect(f.markIssueRead.mock.calls.at(-1)?.[1]).toBe(stamp(100))
    f.activity(200)
    vi.advanceTimersByTime(30_000)
    expect(f.markIssueRead).toHaveBeenCalledTimes(2)
    expect(f.markSessionRead).toHaveBeenCalledTimes(2)
    expect(f.pool.issueObject('root').unread).toBe(true)
    expect(worklistView(f.pool).row(f.pool.issueObject('root')).visibleWorking).toBeTruthy()
    expect(worklistView(f.pool).row(f.pool.issueObject('root')).visibleUnread).toBe(true)
    expect(f.pool.sessionObject('seat').unread).toBe(true)
    f.visible(true)
    expect(f.markIssueRead).toHaveBeenCalledTimes(3)
    expect(f.pool.issueObject('root').unread).toBe(false)
  } finally {
    f.close()
  }
})

it.each([
  'issue',
  'session',
] as const)('preserves manual %s unread through activity, checkpoints and leave', (kind) => {
  const f = fixture()
  try {
    f.update()
    vi.advanceTimersByTime(100)
    f.activity(100)
    f.unread(kind)
    const save = kind === 'issue' ? f.markIssueRead : f.markSessionRead
    const count = save.mock.calls.length
    for (let offset = 200; offset <= 20_000; offset += 100) {
      vi.advanceTimersByTime(100)
      f.activity(offset)
    }
    expect(save).toHaveBeenCalledTimes(count)
    expect(
      kind === 'issue' ? f.pool.issueObject('root').unread : f.pool.sessionObject('seat').unread,
    ).toBe(true)
    f.visible(false)
    expect(save).toHaveBeenCalledTimes(count)
    f.visible(true)
    expect(save).toHaveBeenCalledTimes(count + 1)
  } finally {
    f.close()
  }
})

it('flushes on navigation and reload preparation without reading hidden workspace sessions', () => {
  const f = fixture()
  try {
    f.update()
    vi.advanceTimersByTime(100)
    f.activity(100)
    f.reactions.flushReadAcknowledgements()
    expect(f.markIssueRead).toHaveBeenCalledTimes(2)
    f.activity(200)
    f.state.view = 'issues'
    f.state.openIssueId = asIssueId('child')
    f.update()
    expect(f.markIssueRead.mock.calls.at(-2)).toEqual(['root', stamp(200)])
    expect(f.markSessionRead.mock.calls.at(-1)).toEqual(['seat', stamp(200)])
    f.activity(300)
    vi.advanceTimersByTime(30_000)
    expect(f.pool.sessionObject('seat').unread).toBe(true)
    f.reactions.dispose()
    expect(f.markIssueRead.mock.calls.at(-1)).toEqual(['child', stamp(300)])
  } finally {
    f.close()
  }
})
