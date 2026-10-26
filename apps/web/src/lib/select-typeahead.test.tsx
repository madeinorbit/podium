import { cleanup, createEvent, fireEvent, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { useState } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { CapabilityAgentMenu } from './agent-capability'
import { PropertyMenu } from './PropertyMenu'

afterEach(cleanup)

const options = ['Alpha', 'Apollo', 'Beta', 'Bravo', 'Big model'].map((label) => ({
  value: label,
  label,
}))

function Picker() {
  const [value, setValue] = useState('Alpha')
  return (
    <>
      <PropertyMenu
        typeahead
        trigger={<button type="button">{value}</button>}
        options={options}
        selectedValue={value}
        onSelect={setValue}
      />
      <button type="button">Next field</button>
    </>
  )
}

describe('closed picker typeahead', () => {
  it('selects a case-insensitive prefix after Tab and keeps focus for the next Tab', async () => {
    const user = userEvent.setup()
    render(<Picker />)
    await user.tab()
    await user.keyboard('BR')
    expect(screen.getByRole('button', { name: 'Bravo' })).toBe(document.activeElement)
    expect(screen.queryByRole('menu')).toBeNull()
    await user.tab()
    expect(screen.getByRole('button', { name: 'Next field' })).toBe(document.activeElement)
  })

  it('cycles repeated letters, wraps, and extends the last letter into a prefix', async () => {
    const user = userEvent.setup()
    render(<Picker />)
    await user.tab()
    await user.keyboard('a')
    expect(screen.getByRole('button', { name: 'Apollo' })).toBe(document.activeElement)
    await user.keyboard('a')
    expect(screen.getByRole('button', { name: 'Alpha' })).toBe(document.activeElement)
    await user.keyboard('ap')
    expect(screen.getByRole('button', { name: 'Apollo' })).toBe(document.activeElement)
  })

  it('starts a new prefix after a pause or leaving the field', async () => {
    const user = userEvent.setup()
    render(<Picker />)
    await user.tab()
    const trigger = document.activeElement as HTMLElement
    const key = (letter: string, at: number) => {
      const event = createEvent.keyDown(trigger, { key: letter, bubbles: true })
      Object.defineProperty(event, 'timeStamp', { value: at })
      fireEvent(trigger, event)
    }
    key('b', 100)
    key('r', 200)
    expect(trigger.textContent).toBe('Bravo')
    key('a', 1200)
    expect(trigger.textContent).toBe('Alpha')
    await user.tab()
    await user.tab({ shift: true })
    await user.keyboard('br')
    expect(trigger.textContent).toBe('Bravo')
  })

  it('ignores shortcuts, composing text and unmatched prefixes', async () => {
    const user = userEvent.setup()
    render(<Picker />)
    await user.tab()
    await user.keyboard('{Control>}b{/Control}{Meta>}a{/Meta}{Alt>}b{/Alt}')
    fireEvent.keyDown(document.activeElement as HTMLElement, { key: 'b', isComposing: true })
    await user.keyboard('z')
    expect(screen.getByRole('button', { name: 'Alpha' })).toBe(document.activeElement)
    expect(screen.queryByRole('menu')).toBeNull()
  })

  it('supports spaces inside a prefix and still opens on Space after a fresh focus', async () => {
    const user = userEvent.setup()
    render(<Picker />)
    await user.tab()
    await user.keyboard('big m')
    expect(screen.getByRole('button', { name: 'Big model' })).toBe(document.activeElement)
    expect(screen.queryByRole('menu')).toBeNull()
    await user.tab()
    await user.tab({ shift: true })
    await user.keyboard(' ')
    expect(await screen.findByRole('menu')).toBeTruthy()
  })

  it('leaves filtering and clicking available when the menu is opened', async () => {
    const user = userEvent.setup()
    render(<Picker />)
    await user.tab()
    await user.keyboard('{Enter}')
    const filter = await screen.findByPlaceholderText('Filter…')
    await user.click(filter)
    await user.type(filter, 'Bravo')
    expect(screen.queryByRole('menuitem', { name: 'Alpha' })).toBeNull()
    await user.click(screen.getByRole('menuitem', { name: 'Bravo' }))
    expect(screen.getByRole('button', { name: 'Bravo' })).toBeTruthy()
  })

  it('does not change menus that have not opted into closed-trigger typing', () => {
    const onSelect = vi.fn()
    render(
      <PropertyMenu
        trigger={<button type="button">Pick</button>}
        options={options}
        selectedValue="Alpha"
        onSelect={onSelect}
      />,
    )
    fireEvent.keyDown(screen.getByRole('button'), { key: 'b' })
    expect(onSelect).not.toHaveBeenCalled()
  })
})

it('skips unavailable agents while allowing signed-out agents, just like the menu', async () => {
  const user = userEvent.setup()
  const onSelect = vi.fn()
  render(
    <CapabilityAgentMenu
      typeahead
      trigger={<button type="button">Agent</button>}
      selectedValue="claude-code"
      onSelect={onSelect}
      options={[
        { value: 'claude-code', label: 'Claude', status: {} },
        { value: 'codex', label: 'Codex', status: { reason: 'Not installed' } },
        { value: 'cursor', label: 'Cursor', status: { warning: 'Signed out' } },
      ]}
    />,
  )
  await user.tab()
  await user.keyboard('c')
  expect(onSelect).toHaveBeenCalledExactlyOnceWith('cursor')
  expect(screen.queryByRole('menu')).toBeNull()
})
