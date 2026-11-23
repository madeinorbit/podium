import { cleanup, fireEvent, render } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { useSettingsShortcut } from './use-settings-shortcut'

afterEach(cleanup)
it('opens Settings with Cmd or Ctrl comma, including from an editor, and releases the binding on unmount', () => {
  const open = vi.fn()
  function Harness() {
    useSettingsShortcut(open)
    return <input aria-label="Editor" />
  }
  const { getByRole, unmount } = render(<Harness />)
  const input = getByRole('textbox')
  input.focus()
  for (const modifier of ['ctrlKey', 'metaKey']) {
    const event = new KeyboardEvent('keydown', {
      key: ',',
      [modifier]: true,
      bubbles: true,
      cancelable: true,
    })
    fireEvent(input, event)
    expect(event.defaultPrevented).toBe(true)
  }
  fireEvent.keyDown(input, { key: ',' })
  fireEvent.keyDown(input, { key: ',', ctrlKey: true, altKey: true })
  expect(open).toHaveBeenCalledTimes(2)
  unmount()
  fireEvent.keyDown(window, { key: ',', ctrlKey: true })
  expect(open).toHaveBeenCalledTimes(2)
})
