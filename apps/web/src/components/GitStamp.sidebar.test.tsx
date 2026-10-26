// @vitest-environment happy-dom

import type { IssueGitState } from '@podium/model'
import { cleanup, render } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { GitStamp } from './GitStamp'

const base: IssueGitState = {
  updatedAt: '2026-07-20T12:00:00Z',
  branch: 'issue/236-sidebar-status-grammar',
  shared: false,
  dirtyFiles: 0,
}

afterEach(cleanup)

describe('GitStamp sidebar exception grammar', () => {
  it('keeps clean and no-change states silent', () => {
    const { container, rerender } = render(
      <GitStamp issueBranch={base.branch} git={base} density="stamp" />,
    )
    expect(container.textContent).toBe('')
    rerender(
      <GitStamp
        issueBranch={null}
        git={{ ...base, branch: 'main', shared: true }}
        density="stamp"
      />,
    )
    expect(container.textContent).toBe('')
  })

  it('keeps Git counts silent in the sidebar', () => {
    const { container, rerender } = render(
      <GitStamp
        issueBranch={base.branch}
        git={{ ...base, ahead: 1, dirtyFiles: 2, unpushed: 1 }}
        density="stamp"
      />,
    )
    expect(container.textContent).toBe('')
    expect(container.querySelector('[data-testid^="git-stamp-dot-"]')).toBeNull()
    rerender(<GitStamp issueBranch={base.branch} git={{ ...base, unpushed: 1 }} density="stamp" />)
    expect(container.textContent).toBe('')
  })

  it('preserves the detailed dot grammar outside the sidebar', () => {
    const { container } = render(
      <GitStamp issueBranch={base.branch} git={{ ...base, ahead: 1 }} density="chip" />,
    )
    expect(container.querySelector('[data-testid="git-stamp-dot-clean"]')).toBeTruthy()
  })
})
