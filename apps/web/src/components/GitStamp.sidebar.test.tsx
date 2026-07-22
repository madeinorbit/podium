// @vitest-environment happy-dom
import { cleanup, render } from '@testing-library/react'
import type { IssueGitState } from '@podium/protocol'
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

  it('names actionable git exceptions without positional dots or arrow glyphs', () => {
    const { container } = render(
      <GitStamp
        issueBranch={base.branch}
        git={{ ...base, ahead: 1, dirtyFiles: 2, unpushed: 1 }}
        density="stamp"
      />,
    )
    expect(container.textContent).toContain('2 uncommitted')
    expect(container.textContent).toContain('1 commit ahead')
    expect(container.textContent).toContain('Unpushed')
    expect(container.textContent).not.toContain('⇡')
    expect(container.querySelector('[data-testid^="git-stamp-dot-"]')).toBeNull()
  })

  it('preserves the detailed dot grammar outside the sidebar', () => {
    const { container } = render(
      <GitStamp issueBranch={base.branch} git={{ ...base, ahead: 1 }} density="chip" />,
    )
    expect(container.querySelector('[data-testid="git-stamp-dot-clean"]')).toBeTruthy()
  })
})
