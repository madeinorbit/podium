// @vitest-environment happy-dom
import type { IssueWire } from '@podium/protocol'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { IssueColorPickerButton } from './IssueColorPicker'

function issue(color?: IssueWire['color']): IssueWire {
  return {
    id: 'iss_38',
    repoPath: '/repo',
    seq: 38,
    title: 'Colour flow',
    description: '',
    stage: 'in_progress',
    worktreePath: null,
    branch: null,
    parentBranch: 'main',
    defaultAgent: 'claude-code',
    defaultModel: 'auto',
    defaultEffort: 'auto',
    blockedBy: [],
    priority: 1,
    type: 'task',
    pinned: false,
    needsHuman: false,
    labels: [],
    deps: [],
    dependents: [],
    ready: true,
    blocked: false,
    deferred: false,
    childCount: 0,
    childDoneCount: 0,
    createdAt: '2026-07-14T00:00:00.000Z',
    updatedAt: '2026-07-14T00:00:00.000Z',
    archived: false,
    sessions: [],
    sessionSummary: { total: 0, byPhase: {} },
    ...(color ? { color } : {}),
  }
}

afterEach(cleanup)

describe('IssueColorPickerButton (#38)', () => {
  it('opens from the ID square and optimistically selects a canonical slot', async () => {
    const onChange = vi.fn(async () => undefined)
    render(<IssueColorPickerButton issue={issue()} active={false} onChange={onChange} />)

    const square = screen.getByRole('button', { name: 'Set colour for issue #38' })
    fireEvent.click(square)
    expect(screen.getByRole('dialog', { name: 'Issue colour for #38' })).toBeTruthy()
    expect(screen.getAllByRole('button', { pressed: false })).toHaveLength(10)

    fireEvent.click(screen.getByRole('button', { name: 'Violet' }))
    expect(square.getAttribute('data-color')).toBe('violet')
    await waitFor(() => expect(onChange).toHaveBeenCalledWith('violet'))
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('marks the current colour and clears to the neutral optional field', async () => {
    const onChange = vi.fn(async () => undefined)
    render(<IssueColorPickerButton issue={issue('teal')} active onChange={onChange} />)

    const square = screen.getByRole('button', { name: 'Set colour for issue #38' })
    fireEvent.click(square)
    expect(screen.getByRole('button', { name: 'Teal' }).getAttribute('aria-pressed')).toBe('true')
    fireEvent.click(screen.getByRole('button', { name: 'No colour' }))

    expect(square.getAttribute('data-color')).toBe('none')
    await waitFor(() => expect(onChange).toHaveBeenCalledWith(null))
  })

  it('dismisses on Escape and outside click without mutating', () => {
    const onChange = vi.fn()
    render(<IssueColorPickerButton issue={issue()} active={false} onChange={onChange} />)
    const square = screen.getByRole('button', { name: 'Set colour for issue #38' })

    fireEvent.click(square)
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(document.activeElement).toBe(square)

    fireEvent.click(square)
    fireEvent.mouseDown(document.body)
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(onChange).not.toHaveBeenCalled()
  })
})
