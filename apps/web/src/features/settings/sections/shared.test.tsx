import { normalizeSettings } from '@podium/runtime'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  CommitInput,
  ConfirmInline,
  NumberRow,
  SecretRow,
  SettingsControlsContext,
  SwitchRow,
} from './shared'

const notice = vi.hoisted(() => vi.fn())
vi.mock('sonner', () => ({ toast: Object.assign(notice, { error: vi.fn() }) }))
vi.mock('../settings-frame', () => ({
  useSettingsFrame: () => ({ openTakeover: vi.fn(), closeTakeover: vi.fn() }),
}))
afterEach(() => {
  cleanup()
  notice.mockClear()
})

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
    const input = screen.getByRole('spinbutton', { name: 'Threshold' }) as HTMLInputElement
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
    fireEvent.click(
      screen.getByLabelText('I understand who can use this key.', { selector: 'input' }),
    )
    await waitFor(() => expect(action.disabled).toBe(false))
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

describe('secret removal', () => {
  it('confirms inline and offers the supplied inverse with Undo', async () => {
    const undo = vi.fn(async () => {})
    const remove = vi.fn(async () => undo)
    render(
      <SecretRow label="API key" present last4="1234" onSave={async () => {}} onRemove={remove} />,
    )
    fireEvent.click(screen.getByRole('button', { name: 'Remove' }))
    expect(remove).not.toHaveBeenCalled()
    fireEvent.click(
      within(screen.getByRole('form', { name: 'Remove' })).getByRole('button', { name: 'Remove' }),
    )
    await waitFor(() => expect(remove).toHaveBeenCalledTimes(1))
    await waitFor(() =>
      expect(notice).toHaveBeenCalledWith(
        'Removed',
        expect.objectContaining({ action: expect.objectContaining({ label: 'Undo' }) }),
      ),
    )
    await act(async () => notice.mock.calls.at(-1)![1].action.onClick())
    expect(undo).toHaveBeenCalledTimes(1)
  })
})
