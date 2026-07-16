import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { RefIssueLike, ResolvedRef } from '@/lib/ref-miniview'
import { RefCard } from './RefMiniview'

const parent: RefIssueLike = {
  id: 'iss_parent',
  prefix: 'POD',
  seq: 500,
  displayRef: 'POD-500',
  title: 'Epic',
}

/** A fully-populated issue (a structural subset of IssueWire, like the store holds). */
const rich: RefIssueLike = {
  id: 'iss_1',
  prefix: 'POD',
  seq: 517,
  displayRef: 'POD-517',
  title: 'Enrich the miniview',
  stage: 'in_progress',
  priority: 1,
  assignee: 'agent:claude-code',
  ready: false,
  blocked: true,
  blockedBy: ['iss_a', 'iss_b'],
  childCount: 4,
  childDoneCount: 2,
  parentId: 'iss_parent',
  activityNotes: 'Card now shows stage, todos and status.',
  panel: {
    todos: [
      { text: 'widen data path', done: true },
      { text: 'redesign card', done: true },
      { text: 'tests', done: false },
    ],
  },
}

const issues = [rich, parent]

function issueTarget(issue: RefIssueLike): ResolvedRef {
  return { kind: 'issue', ref: { kind: 'issue', prefix: 'POD', seq: issue.seq }, issue }
}

function renderCard(root: Root, issue: RefIssueLike): void {
  act(() => {
    root.render(
      <RefCard
        refToken={issue.displayRef ?? ''}
        target={issueTarget(issue)}
        issues={issues}
        onClose={() => {}}
        onOpenFull={() => {}}
      />,
    )
  })
}

describe('RefCard issue summary (#517)', () => {
  let container: HTMLDivElement
  let root: Root
  beforeEach(() => {
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
  })
  afterEach(() => {
    act(() => root.unmount())
    container.remove()
  })

  it('derives blocker count, subissue + todo progress, and the resolved parent ref', () => {
    renderCard(root, rich)
    const text = container.textContent ?? ''
    // Identity: the card renders the right issue.
    expect(text).toContain('POD-517')
    expect(text).toContain('Enrich the miniview')
    // Computed values (not passthrough copy): blocker count from blockedBy.length,
    // childDoneCount/childCount, done/total todos, and the resolved parent ref.
    expect(text).toContain('blocked (2)')
    expect(text).toContain('2/4 subissues done')
    expect(text).toContain('2/3 todos')
    expect(text).toContain('in POD-500')
  })

  it('blocked wins over ready', () => {
    renderCard(root, { ...rich, ready: true, blocked: true })
    const text = container.textContent ?? ''
    expect(text).toContain('blocked')
    expect(text).not.toContain('ready')
  })

  it('shows the ready chip when unblocked and ready', () => {
    renderCard(root, { ...rich, blocked: false, blockedBy: [], ready: true })
    const text = container.textContent ?? ''
    expect(text).toContain('ready')
    expect(text).not.toContain('blocked')
  })

  it('degrades to ref + title for a lean issue (no enrichment fields)', () => {
    renderCard(root, { id: 'iss_x', prefix: 'POD', seq: 9, displayRef: 'POD-9', title: 'Lean' })
    const text = container.textContent ?? ''
    expect(text).toContain('POD-9')
    expect(text).toContain('Lean')
    expect(text).not.toContain('subissues')
    expect(text).not.toContain('todos')
  })

  it('omits the parent chip when the parent is not resolvable', () => {
    renderCard(root, { ...rich, parentId: 'iss_gone' })
    expect(container.textContent).not.toContain('in POD-500')
  })
})
