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
