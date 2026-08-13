// @vitest-environment happy-dom

import type { IssueStage } from '@podium/model'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { act, type JSX, Profiler, StrictMode } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { makeIssue } from '@/lib/test-issue'
import { IssuesKanban, type IssuesKanbanProps } from './IssuesKanban'
import { DEFAULT_DISPLAY } from './issues-display'
import { ISSUE_VIRTUAL_MAX_ITEMS } from './use-bounded-virtual-list'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

vi.mock('@/app/store', () => ({
  useStoreSelector: (selector: (store: { sessions: never[] }) => unknown) =>
    selector({ sessions: [] }),
}))

const STAGES: IssueStage[] = ['proposed', 'backlog', 'planning', 'in_progress', 'review', 'done']

const issue = (id: string, stage: IssueStage, seq = 1) =>
  makeIssue({
    id,
    stage,
    seq,
    title: `${stage} task ${seq}`,
    createdAt: '2026-08-01T12:00:00.000Z',
    updatedAt: '2026-08-01T12:00:00.000Z',
  })

function boardProps(over: Partial<IssuesKanbanProps> = {}): IssuesKanbanProps {
  const allIssues = [issue('source', 'backlog'), issue('target', 'review')]
  return {
    columns: STAGES.map((stage) => ({
      stage,
      issues: allIssues.filter((candidate) => candidate.stage === stage),
    })),
    allIssues,
    badges: DEFAULT_DISPLAY.badges,
    ordering: 'priority',
    stageCounts: new Map(),
    epicProgress: new Map(),
    onOpen: vi.fn(),
    onMoveIssue: vi.fn(),
    onApprove: vi.fn(),
    onCreateIn: vi.fn(),
    focusId: null,
    selected: [],
    onToggleSelect: vi.fn(),
    onContextMenu: vi.fn(),
    ...over,
  }
}

function card(id = 'source'): HTMLElement {
  return document.querySelector(`[data-issue-id="${id}"]`) as HTMLElement
}

function dragHandle(id = 'source'): HTMLElement {
  return card(id).parentElement as HTMLElement
}

function pointer(type: string, x: number, y: number, pointerId = 7): PointerEvent {
  return new PointerEvent(type, {
    bubbles: true,
    cancelable: true,
    button: 0,
    clientX: x,
    clientY: y,
    pointerId,
  })
}

let frames: FrameRequestCallback[]
let elementAtPoint: ReturnType<typeof vi.spyOn>

function flushFrame(time = 16): void {
  const callbacks = frames
  frames = []
  for (const callback of callbacks) callback(time)
}

beforeEach(() => {
  frames = []
  vi.spyOn(window, 'requestAnimationFrame').mockImplementation((callback) => {
    frames.push(callback)
    return frames.length
  })
  vi.spyOn(window, 'cancelAnimationFrame').mockImplementation(() => {})
  elementAtPoint = vi.spyOn(document, 'elementFromPoint')
  elementAtPoint.mockImplementation(() => null)
})

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  document.body.style.cursor = ''
})

describe('IssuesKanban pointer drag lifecycle', () => {
  it('keeps a sub-threshold press as the existing click and keyboard interaction', () => {
    const props = boardProps()
    render(<IssuesKanban {...props} />)

    fireEvent(dragHandle(), pointer('pointerdown', 10, 10))
    fireEvent(window, pointer('pointermove', 13, 13))
    fireEvent(window, pointer('pointerup', 13, 13))

    expect(document.querySelector('[aria-hidden="true"].will-change-transform')).toBeNull()
    fireEvent.click(card())
    expect(props.onOpen).toHaveBeenCalledWith('source')
    fireEvent.click(card(), { shiftKey: true })
    expect(props.onToggleSelect).toHaveBeenCalledWith('source')
    fireEvent.contextMenu(card())
    expect(props.onContextMenu).toHaveBeenCalledWith('source', expect.anything())
  })

  it('captures the pointer, suppresses selection/click, and drops in another stage', () => {
    const props = boardProps()
    render(<IssuesKanban {...props} />)
    const source = dragHandle()
    const review = document.querySelector('[data-kanban-column="review"]') as HTMLElement
    const setCapture = vi.fn()
    const releaseCapture = vi.fn()
    Object.assign(source, {
      setPointerCapture: setCapture,
      hasPointerCapture: () => true,
      releasePointerCapture: releaseCapture,
    })
    elementAtPoint.mockReturnValue(review)

    fireEvent(source, pointer('pointerdown', 10, 10))
    fireEvent(window, pointer('pointermove', 30, 35))
    expect(setCapture).toHaveBeenCalledWith(7)
    expect(document.body.style.cursor).toBe('grabbing')
    const selection = new Event('selectstart', { bubbles: true, cancelable: true })
    window.dispatchEvent(selection)
    expect(selection.defaultPrevented).toBe(true)

    act(() => flushFrame())
    expect(screen.getByTestId('kanban-drop-line')).toBeTruthy()
    fireEvent(window, pointer('pointerup', 31, 36))
    fireEvent.click(card())

    expect(props.onMoveIssue).toHaveBeenCalledTimes(1)
    expect(props.onMoveIssue).toHaveBeenCalledWith('source', 'review')
    expect(props.onOpen).not.toHaveBeenCalled()
    expect(releaseCapture).toHaveBeenCalledWith(7)
    expect(document.body.style.cursor).toBe('')
    expect(document.querySelector('.will-change-transform')).toBeNull()
  })

  it('cancels without dropping and removes the proxy, frame, and selection guard', () => {
    const props = boardProps()
    render(<IssuesKanban {...props} />)
    const review = document.querySelector('[data-kanban-column="review"]') as HTMLElement
    elementAtPoint.mockReturnValue(review)

    fireEvent(dragHandle(), pointer('pointerdown', 10, 10))
    fireEvent(window, pointer('pointermove', 40, 40))
    expect(document.querySelector('.will-change-transform')).not.toBeNull()
    fireEvent(window, pointer('pointercancel', 40, 40))

    expect(props.onMoveIssue).not.toHaveBeenCalled()
    expect(document.querySelector('.will-change-transform')).toBeNull()
    expect(document.body.style.cursor).toBe('')
    const selection = new Event('selectstart', { bubbles: true, cancelable: true })
    window.dispatchEvent(selection)
    expect(selection.defaultPrevented).toBe(false)
    act(() => flushFrame())
    expect(screen.queryByTestId('kanban-drop-line')).toBeNull()
  })

  it('keeps a same-stage drop as a no-op', () => {
    const props = boardProps()
    render(<IssuesKanban {...props} />)
    const backlog = document.querySelector('[data-kanban-column="backlog"]') as HTMLElement
    elementAtPoint.mockReturnValue(backlog)

    fireEvent(dragHandle(), pointer('pointerdown', 10, 10))
    fireEvent(window, pointer('pointermove', 30, 30))
    act(() => flushFrame())
    fireEvent(window, pointer('pointerup', 30, 30))

    expect(props.onMoveIssue).not.toHaveBeenCalled()
  })

  it('clears the proxy after StrictMode rehearses the mount effect', () => {
    const props = boardProps()
    render(
      <StrictMode>
        <IssuesKanban {...props} />
      </StrictMode>,
    )
    const review = document.querySelector('[data-kanban-column="review"]') as HTMLElement
    elementAtPoint.mockReturnValue(review)

    fireEvent(dragHandle(), pointer('pointerdown', 10, 10))
    fireEvent(window, pointer('pointermove', 30, 30))
    act(() => flushFrame())
    expect(document.querySelector('.will-change-transform')).not.toBeNull()

    fireEvent(window, pointer('pointerup', 30, 30))

    expect(props.onMoveIssue).toHaveBeenCalledWith('source', 'review')
    expect(document.querySelector('.will-change-transform')).toBeNull()
    expect(screen.queryByTestId('kanban-drop-line')).toBeNull()
  })
})

describe('IssuesKanban large-board render boundary', () => {
  it('restores and reports each column scroll position independently', () => {
    const props = boardProps({
      scrollTops: { backlog: 480, review: 920 },
      onScrollTop: vi.fn(),
    })
    render(<IssuesKanban {...props} />)
    const backlog = document.querySelector('[data-kanban-column="backlog"]') as HTMLElement
    const review = document.querySelector('[data-kanban-column="review"]') as HTMLElement
    const backlogScroll = backlog.querySelector('[data-testid="column-scroll"]') as HTMLElement
    const reviewScroll = review.querySelector('[data-testid="column-scroll"]') as HTMLElement

    expect(backlogScroll.scrollTop).toBe(480)
    expect(reviewScroll.scrollTop).toBe(920)
    backlogScroll.scrollTop = 640
    fireEvent.scroll(backlogScroll)
    expect(props.onScrollTop).toHaveBeenLastCalledWith('backlog', 640)
  })

  it('moves the proxy for every sample but commits only for lifecycle and a changed drop target', () => {
    const columns = STAGES.map((stage, stageIndex) => ({
      stage,
      issues: Array.from({ length: stageIndex < 2 ? 113 : 112 }, (_, index) =>
        issue(`${stage}-${index}`, stage, stageIndex * 100 + index),
      ),
    }))
    const allIssues = columns.flatMap((column) => column.issues)
    expect(allIssues).toHaveLength(674)
    const props = boardProps({ columns, allIssues })
    let commits = 0
    const tree = (): JSX.Element => (
      <Profiler
        id="large-kanban-drag"
        onRender={(_id, phase) => {
          if (phase !== 'mount') commits++
        }}
      >
        <IssuesKanban {...props} />
      </Profiler>
    )
    render(tree())
    const scrollColumns = screen.getAllByTestId('column-scroll')
    for (const column of scrollColumns) {
      Object.defineProperty(column, 'clientHeight', { configurable: true, value: 520 })
      column.scrollTop = 4_000
      fireEvent.scroll(column)
    }
    act(() => flushFrame())
    const mountedCards = document.querySelectorAll('[data-issue-id]').length
    expect(mountedCards).toBeLessThanOrEqual(STAGES.length * ISSUE_VIRTUAL_MAX_ITEMS)
    commits = 0

    const sourceId = 'backlog-40'
    const review = document.querySelector('[data-kanban-column="review"]') as HTMLElement
    elementAtPoint.mockReturnValue(review)
    fireEvent(dragHandle(sourceId), pointer('pointerdown', 10, 10))

    // Five seconds at 60 pointer samples per second. Each sample moves the DOM
    // proxy immediately; each frame hit-tests once and republishes no state
    // because {stage,index} remains identical.
    for (let sample = 1; sample <= 300; sample++) {
      fireEvent(window, pointer('pointermove', 20 + sample, 30 + sample))
      act(() => flushFrame(sample * (1000 / 60)))
    }

    const proxy = document.querySelector('.will-change-transform') as HTMLElement
    expect(proxy.style.transform).toContain('translate3d(310px, 320px, 0)')
    fireEvent(window, pointer('pointerup', 320, 330))

    console.log(
      `[POD-850/POD-853 large board] fixture=674 mountedCards=${mountedCards} ` +
        `bound=${STAGES.length * ISSUE_VIRTUAL_MAX_ITEMS} pointerSamples=300 commits=${commits} ` +
        'expected=lifecycle+window-pin+changed-drop-target',
    )
    // Windowing adds one lifecycle commit while the active drag source becomes
    // a retention pin. Pointer samples themselves still add zero commits.
    expect(commits).toBeLessThanOrEqual(4)
    expect(props.onMoveIssue).toHaveBeenCalledWith(sourceId, 'review')
  }, 15_000)
})
