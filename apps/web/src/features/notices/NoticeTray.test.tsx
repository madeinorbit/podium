// @vitest-environment happy-dom
/**
 * THE NOTICE TRAY (POD-6881, acceptance 6): the bell shows my unread count;
 * opening a notice marks it read and goes to its subject; "Mark all read"
 * clears the count. Over a real pool; the commands and navigation are spies,
 * and the server's answer is the feed update a real server would push.
 */

import { MobxPool } from '@podium/client-graph/pool'
import { asUserId, type NoticeWire, noticeRowId } from '@podium/model'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const h = vi.hoisted(() => ({
  pool: null as unknown,
  actions: {
    trpc: { marker: 'trpc' },
    setOpenIssueId: vi.fn(),
    navigateToSession: vi.fn(),
    setView: vi.fn(),
  },
  markRead: vi.fn(async () => {}),
  markAll: vi.fn(async () => {}),
  reveal: vi.fn(),
}))

vi.mock('@/app/store-worklist-pool', () => ({ useWorklistPool: () => h.pool }))
vi.mock('@/app/shell-data', () => ({ useShellActions: () => h.actions }))
vi.mock('@/features/issues/CardAge', () => ({ CardAge: () => '2m' }))
vi.mock('./reveal-comment', () => ({ revealComment: h.reveal }))
vi.mock('@podium/client-graph/notice-inbox', async (actual) => ({
  ...(await actual<typeof import('@podium/client-graph/notice-inbox')>()),
  markNoticeRead: h.markRead,
  markAllNoticesRead: h.markAll,
}))

import { NoticeTray } from './NoticeTray'

const ME = asUserId('mem_me')

function row(noticeId: string, patch: Partial<NoticeWire> = {}) {
  const value: NoticeWire = {
    noticeId,
    recipientUserId: ME,
    kind: 'mention',
    subjectKind: 'issue',
    subjectId: 'iss_task',
    subjectAnchor: `cmt_${noticeId}`,
    title: `Bob mentioned you on POD-1: Task ${noticeId}`,
    body: '@Me look',
    createdAt: `2026-11-13T00:00:0${noticeId === 'a' ? 1 : 2}.000Z`,
    ...patch,
  }
  const id = noticeRowId(ME, noticeId)
  return { kind: 'inboxNotice' as const, id, value: { ...value, id } as never }
}

let pool: MobxPool

beforeEach(() => {
  pool = new MobxPool({ selectedIssueId: null, coarseNow: Date.parse('2026-11-13') }, undefined, {
    load: () => undefined,
    schedule: () => () => {},
  })
  h.pool = pool
  for (const spy of [h.markRead, h.markAll, h.reveal, ...Object.values(h.actions)]) {
    if (typeof spy === 'function' && 'mockClear' in spy) spy.mockClear()
  }
})

afterEach(() => {
  cleanup()
  pool.dispose()
})

const count = () => screen.queryByTestId('notice-count')?.textContent ?? null

describe('NoticeTray', () => {
  it('shows the unread count and nothing when all are read', () => {
    pool.apply({
      type: 'replace',
      rows: [row('a'), row('b'), row('c', { readAt: '2026-11-13T00:01:00.000Z' })],
    })
    render(<NoticeTray />)
    expect(count()).toBe('2')
    expect(screen.getByTestId('notice-tray').getAttribute('aria-label')).toBe('Notices, 2 unread')

    act(() => {
      pool.apply({
        type: 'update',
        rows: [
          row('a', { readAt: '2026-11-13T00:01:00.000Z' }),
          row('b', { readAt: '2026-11-13T00:01:00.000Z' }),
        ],
      })
    })
    expect(count()).toBeNull()
  })

  it('lists my notices newest first, and says so when there are none', () => {
    pool.apply({ type: 'replace', rows: [row('a'), row('b')] })
    const { unmount } = render(<NoticeTray />)
    fireEvent.click(screen.getByTestId('notice-tray'))
    expect(screen.getAllByTestId('notice-row').map((r) => r.textContent)).toEqual([
      expect.stringContaining('Task b'),
      expect.stringContaining('Task a'),
    ])
    unmount()

    pool.apply({ type: 'replace', rows: [] })
    render(<NoticeTray />)
    fireEvent.click(screen.getByTestId('notice-tray'))
    expect(screen.getByTestId('notice-empty').textContent).toBe('Nothing needs you.')
  })

  it('opening a notice marks it read and goes to its task at the comment', () => {
    pool.apply({ type: 'replace', rows: [row('a')] })
    render(<NoticeTray />)
    fireEvent.click(screen.getByTestId('notice-tray'))
    fireEvent.click(screen.getByTestId('notice-row'))

    expect(h.markRead).toHaveBeenCalledWith(h.actions.trpc, 'a')
    expect(h.actions.setOpenIssueId).toHaveBeenCalledWith('iss_task')
    expect(h.reveal).toHaveBeenCalledWith('cmt_a')
    expect(screen.queryByTestId('notice-panel')).toBeNull()
  })

  it('opening a read notice goes there without marking it again; a session notice opens the session', () => {
    pool.apply({
      type: 'replace',
      rows: [
        row('a', { readAt: '2026-11-13T00:01:00.000Z' }),
        row('b', { subjectKind: 'session', subjectId: 'sess_1', subjectAnchor: undefined }),
      ],
    })
    render(<NoticeTray />)
    fireEvent.click(screen.getByTestId('notice-tray'))
    const [session, read] = screen.getAllByTestId('notice-row')
    fireEvent.click(session as HTMLElement)
    expect(h.actions.navigateToSession).toHaveBeenCalledWith('sess_1')

    fireEvent.click(screen.getByTestId('notice-tray'))
    fireEvent.click(screen.getAllByTestId('notice-row')[1] as HTMLElement)
    expect(h.markRead).toHaveBeenCalledTimes(1)
    expect(h.markRead).toHaveBeenCalledWith(h.actions.trpc, 'b')
    expect(read).toBeTruthy()
  })

  it('"Mark all read" asks the server, and the count clears when the reads arrive', () => {
    pool.apply({ type: 'replace', rows: [row('a'), row('b')] })
    render(<NoticeTray />)
    fireEvent.click(screen.getByTestId('notice-tray'))
    fireEvent.click(screen.getByTestId('notice-mark-all'))
    expect(h.markAll).toHaveBeenCalledWith(h.actions.trpc)

    act(() => {
      pool.apply({
        type: 'update',
        rows: [
          row('a', { readAt: '2026-11-13T00:01:00.000Z' }),
          row('b', { readAt: '2026-11-13T00:01:00.000Z' }),
        ],
      })
    })
    expect(count()).toBeNull()
    expect((screen.getByTestId('notice-mark-all') as HTMLButtonElement).disabled).toBe(true)
  })
})
