import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  closeNewTaskOverlay,
  newTaskOverlayOrigin,
  openNewTaskOverlay,
} from '@/features/worklist/new-task-overlay'
import { NewTaskOverlay } from './NewTaskOverlay'

vi.mock('./ColdStartComposer', () => ({
  ColdStartComposer: () => <textarea aria-label="prompt" />,
}))

afterEach(() => {
  cleanup()
  closeNewTaskOverlay()
  document.body.innerHTML = ''
})

function opener(): HTMLButtonElement {
  const button = document.createElement('button')
  button.textContent = 'New task'
  document.body.append(button)
  button.focus()
  return button
}

describe('the New task overlay', () => {
  it('Cancel restores the view it switched from and hands focus back', () => {
    const button = opener()
    openNewTaskOverlay({ view: 'issues', selectedIssueId: 'iss_a', returnFocus: button })
    const setView = vi.fn()
    render(
      <NewTaskOverlay
        selectedIssueId="iss_a"
        view="workspace"
        baseView="workspace"
        setView={setView}
      />,
    )

    fireEvent.click(screen.getByTestId('new-task-cancel'))

    expect(newTaskOverlayOrigin()).toBeNull()
    expect(setView).toHaveBeenCalledWith('issues')
    expect(document.activeElement).toBe(button)
  })

  it('Esc closes it, leaving the view alone when it never changed', () => {
    openNewTaskOverlay({ view: 'workspace', selectedIssueId: 'iss_a', returnFocus: null })
    const setView = vi.fn()
    render(
      <NewTaskOverlay
        selectedIssueId="iss_a"
        view="workspace"
        baseView="workspace"
        setView={setView}
      />,
    )

    fireEvent.keyDown(screen.getByLabelText('prompt'), { key: 'Escape' })

    expect(newTaskOverlayOrigin()).toBeNull()
    expect(setView).not.toHaveBeenCalled()
  })

  it('leaves Esc to an open menu', () => {
    openNewTaskOverlay({ view: 'workspace', selectedIssueId: null, returnFocus: null })
    render(
      <NewTaskOverlay
        selectedIssueId={null}
        view="workspace"
        baseView="workspace"
        setView={vi.fn()}
      />,
    )
    const menu = document.createElement('div')
    menu.setAttribute('role', 'menu')
    menu.tabIndex = -1
    document.body.append(menu)

    fireEvent.keyDown(menu, { key: 'Escape' })
    expect(newTaskOverlayOrigin()).not.toBeNull()

    // A menu inside the overlay that handled Esc marks it.
    const event = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })
    event.preventDefault()
    act(() => {
      screen.getByLabelText('prompt').dispatchEvent(event)
    })
    expect(newTaskOverlayOrigin()).not.toBeNull()
  })

  it('Esc closes it even after focus has left the overlay', () => {
    openNewTaskOverlay({ view: 'workspace', selectedIssueId: null, returnFocus: null })
    render(
      <NewTaskOverlay
        selectedIssueId={null}
        view="workspace"
        baseView="workspace"
        setView={vi.fn()}
      />,
    )
    const rail = document.createElement('button')
    document.body.append(rail)

    fireEvent.keyDown(rail, { key: 'Escape' })

    expect(newTaskOverlayOrigin()).toBeNull()
  })

  it('keeps Tab inside the overlay', () => {
    // jsdom has no layout; every control counts as rendered.
    const rects = vi
      .spyOn(Element.prototype, 'getClientRects')
      .mockReturnValue([{}] as unknown as DOMRectList)
    openNewTaskOverlay({ view: 'workspace', selectedIssueId: null, returnFocus: null })
    render(
      <NewTaskOverlay
        selectedIssueId={null}
        view="workspace"
        baseView="workspace"
        setView={vi.fn()}
      />,
    )
    const cancel = screen.getByTestId('new-task-cancel')
    const prompt = screen.getByLabelText('prompt')
    const rail = document.createElement('button')
    document.body.append(rail)

    // Tab off the last control wraps to the first; Shift+Tab off the first wraps back.
    prompt.focus()
    fireEvent.keyDown(prompt, { key: 'Tab' })
    expect(document.activeElement).toBe(cancel)
    fireEvent.keyDown(cancel, { key: 'Tab', shiftKey: true })
    expect(document.activeElement).toBe(prompt)
    // Focus somewhere outside is pulled back in.
    rail.focus()
    fireEvent.keyDown(rail, { key: 'Tab' })
    expect(document.activeElement).toBe(cancel)
    rects.mockRestore()
  })

  it('steps aside when the operator selects another task', () => {
    openNewTaskOverlay({ view: 'workspace', selectedIssueId: 'iss_a', returnFocus: null })
    const view = render(
      <NewTaskOverlay
        selectedIssueId="iss_a"
        view="workspace"
        baseView="workspace"
        setView={vi.fn()}
      />,
    )
    expect(newTaskOverlayOrigin()).not.toBeNull()

    view.rerender(
      <NewTaskOverlay
        selectedIssueId="iss_b"
        view="workspace"
        baseView="workspace"
        setView={vi.fn()}
      />,
    )
    expect(newTaskOverlayOrigin()).toBeNull()
  })
})
