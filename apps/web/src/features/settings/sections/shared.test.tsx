import { normalizeSettings } from '@podium/runtime'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { CommitInput, ConfirmInline, NumberRow, SettingsControlsContext, SwitchRow } from './shared'

afterEach(cleanup)

describe('commit fields', () => {
  it('leaves keystrokes alone and commits once on Enter followed by blur', () => {
    const commit = vi.fn()
    render(
      <CommitInput
        aria-label="Memory"
        type="number"
        min={50}
        max={95}
        value={80}
        onChange={(event) => commit(event.target.value)}
      />,
    )
    const input = screen.getByLabelText('Memory') as HTMLInputElement
    fireEvent.focus(input)
    fireEvent.change(input, { target: { value: '8' } })
    expect(input.value).toBe('8')
    expect(commit).not.toHaveBeenCalled()
    fireEvent.change(input, { target: { value: '85' } })
    fireEvent.keyDown(input, { key: 'Enter' })
    fireEvent.blur(input)
    expect(commit).toHaveBeenCalledExactlyOnceWith('85')
  })
  it('drops local text on Escape without writing it on blur', () => {
    const commit = vi.fn()
    render(<CommitInput aria-label="Topic" value="saved" onChange={commit} />)
    const input = screen.getByLabelText('Topic') as HTMLInputElement
    fireEvent.change(input, { target: { value: 'unsent' } })
    fireEvent.keyDown(input, { key: 'Escape' })
    fireEvent.blur(input)
    expect(input.value).toBe('saved')
    expect(commit).not.toHaveBeenCalled()
  })
  it('clamps a number only on commit and preserves an empty off value', async () => {
    const commit = vi.fn()
    render(
      <NumberRow
        label="Threshold"
        value={80}
        min={50}
        max={95}
        onChange={commit}
        placeholder="Off"
      />,
    )
    const input = screen.getByLabelText('Threshold') as HTMLInputElement
    fireEvent.change(input, { target: { value: '8' } })
    expect(input.value).toBe('8')
    expect(commit).not.toHaveBeenCalled()
    fireEvent.blur(input)
    await waitFor(() => expect(commit).toHaveBeenCalledWith(50))
    fireEvent.change(input, { target: { value: '' } })
    fireEvent.blur(input)
    await waitFor(() => expect(commit).toHaveBeenLastCalledWith(null))
  })
  it('shows a rejected value unchanged with the reason on its row', async () => {
    render(
      <SwitchRow
        label="Mirror"
        value={false}
        onChange={async () => {
          throw new Error('Not allowed here')
        }}
      />,
    )
    fireEvent.click(screen.getByRole('switch'))
    expect(await screen.findByRole('alert')).toHaveProperty('textContent', 'Not allowed here')
    expect(screen.getByRole('switch').getAttribute('aria-checked')).toBe('false')
  })
  it('renders a member’s workspace value without an interactive control', () => {
    render(
      <SettingsControlsContext.Provider
        value={{
          settings: normalizeSettings({}),
          permitted: { 'records.userPreferences.edit': true },
        }}
      >
        <SwitchRow
          setting="hibernation.enabled"
          label="Pause sessions"
          value={true}
          onChange={vi.fn()}
        />
        <SwitchRow setting="notifications.web" label="Notify me" value={true} onChange={vi.fn()} />
      </SettingsControlsContext.Provider>,
    )
    expect(screen.getAllByRole('switch')).toHaveLength(1)
    expect(screen.getByRole('switch').getAttribute('aria-label')).toBe('Notify me')
    expect(screen.getByText('On')).toBeTruthy()
  })
})

describe('inline confirmation requirements', () => {
  it('requires both the existing password and acknowledgement before calling the action', async () => {
    const confirm = vi.fn()
    render(
      <ConfirmInline
        sentence="Send this key to a shared machine?"
        actionLabel="Send key"
        hasPassword
        acknowledgement="I understand who can use this key."
        onConfirm={confirm}
        onCancel={vi.fn()}
      />,
    )
    const action = screen.getByRole('button', { name: 'Send key' }) as HTMLButtonElement
    expect(action.disabled).toBe(true)
    fireEvent.change(screen.getByLabelText('Your password'), {
      target: { value: 'correct password' },
    })
    expect(action.disabled).toBe(true)
    fireEvent.click(screen.getByRole('checkbox'))
    expect(action.disabled).toBe(false)
    fireEvent.click(action)
    await waitFor(() => expect(confirm).toHaveBeenCalledExactlyOnceWith('correct password'))
  })
  it('does not ask passwordless viewers for a password and retains server refusal feedback', async () => {
    render(
      <ConfirmInline
        sentence="Remove this machine?"
        actionLabel="Remove"
        onCancel={vi.fn()}
        onConfirm={async () => {
          throw new Error('The machine is still in use.')
        }}
      />,
    )
    expect(screen.queryByLabelText('Your password')).toBeNull()
    expect((screen.getByRole('button', { name: 'Remove' }) as HTMLButtonElement).disabled).toBe(
      false,
    )
    fireEvent.click(screen.getByRole('button', { name: 'Remove' }))
    expect((await screen.findByRole('alert')).textContent).toBe('The machine is still in use.')
  })
})
