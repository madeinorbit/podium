import { issueReferenceModel, type IssueReferenceSource } from '@podium/client-core/values'
import { describe, expect, it, vi } from 'vitest'
import { bindIssueRefAnchors, paintIssueRefAnchor } from './issue-chip-liveness'

function issue(overrides: Partial<IssueReferenceSource> = {}): IssueReferenceSource {
  return {
    id: 'issue-13' as IssueReferenceSource['id'],
    seq: 13,
    prefix: 'POD',
    displayRef: 'POD-13',
    title: 'Stable chips',
    stage: 'in_progress',
    archived: false,
    ...overrides,
  }
}

function rowWithRef(ref = 'POD-13'): { row: HTMLElement; anchor: HTMLAnchorElement } {
  const row = document.createElement('article')
  row.className = 'transcript-row'
  row.innerHTML = `<p>Follow <a class="ref-link ref-link--issue" data-ref="${ref}">${ref}</a></p>`
  const anchor = row.querySelector<HTMLAnchorElement>('a')
  if (!anchor) throw new Error('fixture anchor missing')
  return { row, anchor }
}

describe('live transcript issue references', () => {
  it('updates only attributes while preserving the exact row, anchor, and text nodes', () => {
    const { row, anchor } = rowWithRef()
    const root = document.createElement('div')
    root.appendChild(row)
    const originalRow = root.firstChild
    const text = anchor.firstChild
    const paragraph = anchor.parentNode

    paintIssueRefAnchor(anchor, issueReferenceModel(issue()))
    paintIssueRefAnchor(anchor, issueReferenceModel(issue({ stage: 'done', archived: true })))

    expect(root.firstChild).toBe(originalRow)
    expect(root.querySelector('.transcript-row')).toBe(row)
    expect(row.querySelector('p')).toBe(paragraph)
    expect(row.querySelector('a')).toBe(anchor)
    expect(anchor.firstChild).toBe(text)
    expect(anchor.textContent).toBe('POD-13')
    expect(anchor.getAttribute('data-issue-stage')).toBe('done')
    expect(anchor.getAttribute('data-issue-availability')).toBe('archived')
    expect(anchor.getAttribute('aria-label')).toBe('Archived Done task POD-13: Stable chips')
  })

  it('preserves a selection and emits no child-list mutations across a stage update', async () => {
    const { row, anchor } = rowWithRef()
    document.body.appendChild(row)
    const text = anchor.firstChild
    if (!text) throw new Error('fixture text missing')
    const range = document.createRange()
    range.selectNodeContents(anchor)
    const selection = window.getSelection()
    selection?.removeAllRanges()
    selection?.addRange(range)

    const childMutations: MutationRecord[] = []
    const observer = new MutationObserver((records) => {
      childMutations.push(...records.filter((record) => record.type === 'childList'))
    })
    observer.observe(row, { childList: true, subtree: true, attributes: true })

    paintIssueRefAnchor(anchor, issueReferenceModel(issue()))
    paintIssueRefAnchor(anchor, issueReferenceModel(issue({ stage: 'review' })))
    await Promise.resolve()

    expect(anchor.firstChild).toBe(text)
    expect(selection?.toString()).toBe('POD-13')
    expect(childMutations).toEqual([])
    observer.disconnect()
    selection?.removeAllRanges()
    row.remove()
  })

  it('clears stale visible state when a reference becomes unavailable', () => {
    const { anchor } = rowWithRef()
    paintIssueRefAnchor(anchor, issueReferenceModel(issue({ stage: 'review' })))
    expect(anchor.getAttribute('data-issue-stage')).toBe('review')

    paintIssueRefAnchor(anchor, null)
    expect(anchor.hasAttribute('data-issue-stage')).toBe(false)
    expect(anchor.getAttribute('data-issue-availability')).toBe('unavailable')
    expect(anchor.getAttribute('aria-label')).toBe('Task POD-13 is unavailable')
  })

  it('never decorates session refs or ordinary links', () => {
    const root = document.createElement('div')
    root.innerHTML =
      '<a class="ref-link ref-link--session" data-ref="POD-13-A">POD-13-A</a>' +
      '<a href="https://example.com">Example</a>'
    const watch = vi.fn(() => () => {})
    const stop = bindIssueRefAnchors(root, { watch })
    expect(watch).not.toHaveBeenCalled()
    stop()
    for (const anchor of root.querySelectorAll('a')) {
      expect(anchor.hasAttribute('data-issue-stage')).toBe(false)
      expect(anchor.hasAttribute('data-issue-availability')).toBe(false)
    }
  })
})
