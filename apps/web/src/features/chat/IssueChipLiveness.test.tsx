import type { IssueReferenceSource } from '@podium/client-core/viewmodels'
import { act, type JSX, useState } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { IssueChipLiveness } from './IssueChipLiveness'

const fixture = vi.hoisted(() => ({
  issues: [
    {
      id: 'issue-13',
      seq: 13,
      prefix: 'POD',
      displayRef: 'POD-13',
      title: 'Stable chips',
      stage: 'review',
      archived: false,
    },
  ],
}))

vi.mock('@/app/store', () => ({
  useReplicaIssues: () => fixture.issues as IssueReferenceSource[],
}))

function LivenessBeforeHost(): JSX.Element {
  const [host, setHost] = useState<HTMLDivElement | null>(null)
  return (
    <>
      <IssueChipLiveness root={host} />
      <div ref={setHost}>
        <a className="ref-link ref-link--issue" href="#POD-13" data-ref="POD-13">
          POD-13
        </a>
      </div>
    </>
  )
}

describe('IssueChipLiveness host lifecycle', () => {
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

  it('decorates when its callback-ref host attaches after the subscriber mounts', () => {
    act(() => root.render(<LivenessBeforeHost />))

    const anchor = container.querySelector<HTMLAnchorElement>('a[data-ref="POD-13"]')
    expect(anchor?.getAttribute('data-issue-stage')).toBe('review')
    expect(anchor?.getAttribute('data-issue-availability')).toBe('present')
    expect(anchor?.getAttribute('aria-label')).toBe('Review task POD-13: Stable chips')
  })
})
