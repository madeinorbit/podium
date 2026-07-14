import { nativeAccountId } from '@podium/runtime'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { accountOptions, RoleBackendEditor } from './shared'

vi.mock('@/app/store', () => {
  const useStore = () => ({ trpc: {} })
  return {
    useStore,
    useStoreSelector: (selector: (store: unknown) => unknown) => selector(useStore()),
  }
})

afterEach(cleanup)

describe('RoleBackendEditor', () => {
  it('allows effort selection while the model is automatic', () => {
    render(
      // Biome mistakes this component prop for an ARIA role attribute.
      // biome-ignore lint/a11y/useValidAriaRole: this selects the Podium backend role
      <RoleBackendEditor
        role="coding"
        backend={{ accountId: nativeAccountId('codex'), model: 'auto', effort: 'auto' }}
        accounts={[]}
        onChange={vi.fn()}
      />,
    )

    expect(screen.getByRole('combobox').textContent).toContain('Codex (ChatGPT)')
    fireEvent.click(screen.getByRole('button', { name: 'Effort' }))
    expect(screen.getByRole('menuitem', { name: 'Extra high' })).toBeTruthy()
  })

  it('uses the shared Codex model and effort dropdowns and persists the harness', () => {
    const onChange = vi.fn()
    render(
      // Biome mistakes this component prop for an ARIA role attribute.
      // biome-ignore lint/a11y/useValidAriaRole: this selects the Podium backend role
      <RoleBackendEditor
        role="superagent"
        backend={{
          accountId: nativeAccountId('codex'),
          model: 'gpt-5.5',
          effort: 'auto',
        }}
        accounts={[]}
        onChange={onChange}
      />,
    )

    fireEvent.click(screen.getByRole('button', { name: 'Model' }))
    fireEvent.click(screen.getByRole('menuitem', { name: 'GPT-5.4' }))
    expect(onChange).toHaveBeenCalledWith({
      accountId: nativeAccountId('codex'),
      harness: 'codex',
      model: 'gpt-5.4',
      effort: 'auto',
    })

    fireEvent.click(screen.getByRole('button', { name: 'Effort' }))
    expect(screen.getByRole('menuitem', { name: 'Extra high' })).toBeTruthy()
  })
})

describe('accountOptions', () => {
  it('only offers execution paths supported by each role', () => {
    expect(accountOptions('superagent').map((option) => option.id)).toEqual([
      'native:claude-code',
      'native:codex',
      'native:grok',
      'native:opencode',
      'native:cursor',
    ])
    expect(accountOptions('background').map((option) => option.id)).toEqual([
      'native:codex',
      'managed:anthropic',
      'managed:openai',
      'managed:openrouter',
    ])
  })
})

/**
 * The chain that makes #216 real: server-held credential → spawn env. It is only
 * reachable if the CODING role can actually be pointed at a managed account.
 *
 * These are the tests that would have caught the severed link: injection was green
 * end-to-end, but ONLY for `roles.coding.accountId = 'managed:*'` — a setting the
 * picker refused to produce, so no real user could ever reach it.
 */
describe('accountOptions', () => {
  it('offers managed accounts for the CODING role — this is what makes #216 reachable', () => {
    const ids = accountOptions('coding').map((o) => o.id)
    // The credential Podium injects into a coding harness spawn.
    expect(ids).toContain('managed:anthropic')
    expect(ids).toContain('managed:claude-oauth')
    expect(ids).toContain('managed:openai')
    // Native logins stay exactly as they were.
    expect(ids).toContain('native:claude-code')
    expect(ids).toContain('native:codex')
  })

  it('does not offer a credential no coding CLI can authenticate with', () => {
    // OPENROUTER_API_KEY authenticates none of the coding harnesses; offering it
    // would spawn an agent that silently falls back to the machine's own login.
    expect(accountOptions('coding').map((o) => o.id)).not.toContain('managed:openrouter')
    // It remains valid for the API-backed roles.
    expect(accountOptions('background').map((o) => o.id)).toContain('managed:openrouter')
  })
})

describe('RoleBackendEditor · managed account for the coding role (#216)', () => {
  /** Open the Nth select (0 = Account, 1 = Harness) and pick `label`. A Base UI
   *  select only commits on a real pointer sequence — a bare click is a no-op. */
  function pick(select: number, label: string | RegExp): void {
    fireEvent.click(screen.getAllByRole('combobox')[select] as HTMLElement)
    const option = screen.getByRole('option', { name: label })
    fireEvent.pointerDown(option)
    fireEvent.pointerUp(option)
    fireEvent.click(option)
  }
  const pickAccount = (label: string | RegExp): void => pick(0, label)

  it('writes the managed accountId AND a harness to run it on', () => {
    const onChange = vi.fn()
    render(
      // biome-ignore lint/a11y/useValidAriaRole: this selects the Podium backend role
      <RoleBackendEditor
        role="coding"
        backend={{ accountId: nativeAccountId('claude-code'), model: 'auto', effort: 'auto' }}
        accounts={[]}
        onChange={onChange}
      />,
    )

    pickAccount(/Anthropic API key \(managed\)/)
    // Without `harness` the role is ambiguous: resolveRole() would decode the
    // managed id as an API backend and never run a CLI.
    expect(onChange).toHaveBeenCalledWith({
      accountId: 'managed:anthropic',
      harness: 'claude-code',
      model: 'auto',
      effort: 'auto',
    })
  })

  it('defaults the Claude subscription to claude-code and OpenAI to codex', () => {
    const onChange = vi.fn()
    const { rerender } = render(
      // biome-ignore lint/a11y/useValidAriaRole: this selects the Podium backend role
      <RoleBackendEditor
        role="coding"
        backend={{ accountId: nativeAccountId('claude-code'), model: 'auto', effort: 'auto' }}
        accounts={[]}
        onChange={onChange}
      />,
    )
    pickAccount(/Claude subscription \(managed\)/)
    expect(onChange).toHaveBeenCalledWith(
      expect.objectContaining({ accountId: 'managed:claude-oauth', harness: 'claude-code' }),
    )

    onChange.mockClear()
    rerender(
      // biome-ignore lint/a11y/useValidAriaRole: this selects the Podium backend role
      <RoleBackendEditor
        role="coding"
        backend={{ accountId: nativeAccountId('claude-code'), model: 'auto', effort: 'auto' }}
        accounts={[]}
        onChange={onChange}
      />,
    )
    pickAccount(/OpenAI API key \(managed\)/)
    expect(onChange).toHaveBeenCalledWith(
      expect.objectContaining({ accountId: 'managed:openai', harness: 'codex' }),
    )
  })

  it('switching back to a native account CLEARS the harness', () => {
    const onChange = vi.fn()
    render(
      // biome-ignore lint/a11y/useValidAriaRole: this selects the Podium backend role
      <RoleBackendEditor
        role="coding"
        backend={{ accountId: 'managed:openai', harness: 'codex', model: 'auto', effort: 'auto' }}
        accounts={[]}
        onChange={onChange}
      />,
    )
    pickAccount('Claude Code')
    // A stale `harness: codex` on a native:claude-code account would make
    // resolveRole() run codex — the patch must write the key, not omit it.
    expect(onChange).toHaveBeenCalledWith({
      accountId: nativeAccountId('claude-code'),
      harness: undefined,
      model: 'auto',
      effort: 'auto',
    })
  })
})
