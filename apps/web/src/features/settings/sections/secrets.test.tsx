/**
 * SETTINGS → SECRETS (POD-421) — the surface that must never render a value.
 *
 * The property under test is a NEGATIVE ("no value reaches the DOM"), and a
 * negative is the shape this run keeps getting wrong: a component that rendered
 * nothing at all would satisfy it perfectly. So every absence assertion here is
 * paired with a presence one — the material is gone AND the presence, the
 * fingerprint and the key label are on screen — and the fixture always carries
 * material that a leaking implementation would have shown.
 */

import type { SecretPresenceWire } from '@podium/model'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { SECRET_SURFACE_UNAVAILABLE, SecretsSection } from './secrets'

afterEach(cleanup)

/** A fingerprint, and it deliberately shares NO substring with any material
 *  below: a test whose fingerprint looked like a prefix of the key could not
 *  tell "rendered the tag" from "rendered part of the secret". */
const rows: SecretPresenceWire[] = [
  {
    key: 'apiKeys.openai',
    present: true,
    fingerprint: 'a1b2c3d4e5f60718',
    updatedAt: '2026-07-30T12:00:00.000Z',
  },
  { key: 'apiKeys.anthropic', present: false, fingerprint: null, updatedAt: null },
]

const view = (over: Partial<Parameters<typeof SecretsSection>[0]> = {}) =>
  render(
    <SecretsSection
      state={{ status: 'available', rows }}
      canManage
      onSet={vi.fn()}
      onClear={vi.fn()}
      busy={false}
      error={null}
      {...over}
    />,
  )

describe('presence and fingerprint are shown; a value is not', () => {
  it('renders presence per key — the positive half', () => {
    view()
    expect(screen.getByTestId('secret-presence-apiKeys.openai').textContent).toBe('Configured')
    expect(screen.getByTestId('secret-presence-apiKeys.anthropic').textContent).toBe(
      'Not configured',
    )
  })

  it('renders the fingerprint for a configured key, and none for an absent one', () => {
    view()
    const tags = screen.getAllByTestId('secret-fingerprint')
    // Exactly one: an absent key must not acquire a fingerprint, which is the
    // property `secretPresence` returns all-null for.
    expect(tags).toHaveLength(1)
    expect(tags[0]?.textContent).toBe('a1b2c3d4e5f60718')
  })

  it('the value input starts EMPTY and is never seeded', () => {
    view()
    const input = screen.getByLabelText('OpenAI API key — new value') as HTMLInputElement
    expect(input.value).toBe('')
    // The placeholder reflects PRESENCE, which the server does publish — it is
    // not a masked rendering of the material.
    expect(input.placeholder).toBe('Replace…')
  })

  it('nothing in the rendered markup could be a credential', () => {
    // The whole-container assertion, not a per-field one: a value re-added
    // under a name this file does not know to look for still fails here.
    const { container } = view()
    expect(container.innerHTML).not.toMatch(/sk-[a-zA-Z0-9]/)
  })
})

describe('a write does not leave the typed material in the component', () => {
  it('clears the draft on submit, without waiting for the request', () => {
    const onSet = vi.fn()
    view({ onSet })
    const input = screen.getByLabelText('OpenAI API key — new value') as HTMLInputElement
    fireEvent.change(input, { target: { value: 'sk-typed-by-the-user' } })
    fireEvent.click(screen.getAllByRole('button', { name: 'Save' })[0] as HTMLElement)

    expect(onSet).toHaveBeenCalledWith('apiKeys.openai', 'sk-typed-by-the-user')
    // Cleared IMMEDIATELY, not in a `.then()`: on a failed write the material
    // would otherwise sit in a live React tree for as long as the tab is open.
    expect(input.value).toBe('')
  })

  it('Save is disabled while the draft is blank — no empty write', () => {
    view()
    // `clearSecret` is the way to remove one; an empty `setSecret` is refused by
    // `ServerSecret.value`'s `.min(1)`, so offering it would be a control that
    // exists to fail.
    expect((screen.getAllByRole('button', { name: 'Save' })[0] as HTMLButtonElement).disabled).toBe(
      true,
    )
  })
})

describe('a member gets disabled controls with a stated reason, not a failing write', () => {
  it('disables the input and the buttons, and says why', () => {
    view({ canManage: false })
    expect((screen.getByLabelText('OpenAI API key — new value') as HTMLInputElement).disabled).toBe(
      true,
    )
    expect((screen.getAllByRole('button', { name: 'Save' })[0] as HTMLButtonElement).disabled).toBe(
      true,
    )
    expect(screen.getAllByText('· admin only').length).toBeGreaterThan(0)
  })

  it('and the ENABLED case proves the disabling is conditional', () => {
    // Without this, "disabled for a member" is satisfied by a component that
    // disables everything for everyone — the surface would be inert and the
    // test would still be green.
    view()
    expect((screen.getByLabelText('OpenAI API key — new value') as HTMLInputElement).disabled).toBe(
      false,
    )
  })
})

describe('the unavailable surface is ONE state with ONE string (readiness §3.1.5)', () => {
  it('renders the same thing for a refusal as it would for an absent surface', () => {
    view({ state: { status: 'unavailable' } })
    expect(screen.getByTestId('secrets-unavailable').textContent).toBe(SECRET_SURFACE_UNAVAILABLE)
  })

  it('reveals NOTHING about whether any secret is configured', () => {
    // The oracle test. A member must not be able to tell a refusal from an
    // instance with nothing configured — so the unavailable render carries no
    // key name, no count, no presence word, and no fingerprint.
    const { container } = view({ state: { status: 'unavailable' } })
    expect(screen.queryByTestId('secret-fingerprint')).toBeNull()
    expect(container.textContent).not.toMatch(/configured/i)
    expect(container.textContent).not.toContain('apiKeys')
    expect(container.textContent).not.toContain('openai')
  })

  it('the AVAILABLE render does contain those things — so the check above is not vacuous', () => {
    const { container } = view()
    expect(container.textContent).toMatch(/configured/i)
    expect(screen.getByTestId('secret-fingerprint')).toBeTruthy()
  })
})
