import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { makeIssue } from '@/lib/test-issue'
import { RightRail } from './RightRail'

afterEach(cleanup)

describe('RightRail', () => {
  it('reopens the last panel and switches one panel at a time — with no superagent control (#65)', () => {
    const onPanelChange = vi.fn()
    render(<RightRail rightPanel={null} lastPanel="git" onPanelChange={onPanelChange} />)

    fireEvent.click(screen.getByRole('button', { name: 'Open last panel' }))
    expect(onPanelChange).toHaveBeenLastCalledWith('git')

    fireEvent.click(screen.getByRole('button', { name: 'Files' }))
    expect(onPanelChange).toHaveBeenLastCalledWith('files')

    expect(screen.queryByRole('button', { name: /superagent/i })).toBeNull()
  })

  it('toggles the active panel closed', () => {
    const onPanelChange = vi.fn()
    render(<RightRail rightPanel="shell" lastPanel="shell" onPanelChange={onPanelChange} />)
    fireEvent.click(screen.getByRole('button', { name: 'Shell' }))
    expect(onPanelChange).toHaveBeenCalledWith(null)
  })

  it('renders the selected issue as the designed ID square and toggles the Issue panel on click', () => {
    const onPanelChange = vi.fn()
    const issue = makeIssue({ id: 'i1', seq: 65 })
    render(
      <RightRail
        issue={issue}
        rightPanel={null}
        lastPanel="issue"
        onPanelChange={onPanelChange}
        onColorChange={vi.fn()}
      />,
    )
    const square = screen.getByTestId('issue-id-square')
    // The square language's chrome, not the old borderless text cell.
    expect(square.style.border).not.toBe('')
    expect(square.style.background).toBe('#25252f') // uncoloured fill
    fireEvent.click(square)
    expect(onPanelChange).toHaveBeenLastCalledWith('issue')
  })

  it('keeps panel-toggle semantics when the Issue panel is already open (primaryOnly, no picker)', () => {
    const onPanelChange = vi.fn()
    const issue = makeIssue({ id: 'i1', seq: 65 })
    render(
      <RightRail
        issue={issue}
        rightPanel="issue"
        lastPanel="issue"
        onPanelChange={onPanelChange}
        onColorChange={vi.fn()}
      />,
    )
    fireEvent.click(screen.getByTestId('issue-id-square'))
    expect(onPanelChange).toHaveBeenLastCalledWith(null)
    expect(screen.queryByText('ISSUE COLOUR')).toBeNull()
  })

  it('falls back to a dashed resting square when no issue is selected', () => {
    const onPanelChange = vi.fn()
    render(<RightRail rightPanel={null} lastPanel="issue" onPanelChange={onPanelChange} />)
    const fallback = screen.getByRole('button', { name: 'Task' })
    expect(fallback.className).toContain('border-dashed')
    fireEvent.click(fallback)
    expect(onPanelChange).toHaveBeenLastCalledWith('issue')
  })
})
