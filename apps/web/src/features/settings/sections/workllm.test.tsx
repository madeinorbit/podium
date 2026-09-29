import { asAccountId, asMachineId } from '@podium/model'
import { bundledDescriptorFor, effectiveCatalogModel } from '@podium/harness/browser'
import { nativeAccountId, normalizeSettings } from '@podium/runtime'
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import '@/test-support/model-catalog-mock'
import type { AccountView } from './shared'
import { WorkLlmSection } from './workllm'

vi.mock('@/app/store', () => {
  const useStore = () => ({ trpc: {} })
  return {
    useStore,
    useReplicaIssues: () => (useStore() as unknown as { issues?: unknown[] }).issues ?? [],
    useStoreSelector: (selector: (store: unknown) => unknown) => selector(useStore()),
  }
})

afterEach(cleanup)

const CODEX_ACCOUNT: AccountView = {
  id: 'native:codex',
  provider: 'openai',
  source: 'native',
  harness: 'codex',
  status: 'connected',
  identity: 'user@example.com',
}

function backgroundSettings() {
  return normalizeSettings({
    roles: {
      background: {
        accountId: nativeAccountId('codex'),
        model: 'auto',
        effort: 'auto',
      },
    },
  })
}

describe('WorkLlmSection', () => {
  it('shows the background last-error when the assistant recorded one (POD-4805)', () => {
    render(
      <WorkLlmSection
        settings={backgroundSettings()}
        accounts={[
          {
            ...CODEX_ACCOUNT,
            serverAi: {
              machineId: asMachineId('desk'),
              machineName: 'Desk',
              lastError: "codex 400: The 'gpt-5.5' model is not supported.",
            },
          },
        ]}
        patch={() => {}}
      />,
    )

    expect(screen.getByText(/Background LLM last failed: /)).toBeTruthy()
    expect(screen.getByText(/not supported/)).toBeTruthy()
  })

  it('shows nothing extra when no failure was recorded', () => {
    render(
      <WorkLlmSection
        settings={backgroundSettings()}
        accounts={[{ ...CODEX_ACCOUNT, serverAi: { machineId: asMachineId('desk'), machineName: 'Desk' } }]}
        patch={() => {}}
      />,
    )

    expect(screen.queryByText(/last failed/)).toBeNull()
  })

  it("shows the model the call will actually use for 'auto' (POD-4805)", () => {
    // Displayed and called read the same catalog function: the section shows
    // the head the server's one-shot client sends (asserted on the call side
    // in apps/server codex-transport.test.ts), never a second resolution.
    const head = effectiveCatalogModel(bundledDescriptorFor('codex'), 'auto')
    expect(head).toBeTruthy()
    render(<WorkLlmSection settings={backgroundSettings()} accounts={[]} patch={() => {}} />)

    expect(screen.getByText(`Effective model: ${head} (Model is Auto)`)).toBeTruthy()
  })

  it('shows the server-truth account for an unset role, not the picker fallback (POD-4805)', () => {
    // Stored {accountId:'', model:'auto'}: the server runs the role default
    // (managed:openrouter), so the page must show OpenRouter — the old
    // first-option fallback displayed a Codex login the call never spends.
    const unset = normalizeSettings({
      roles: { background: { accountId: asAccountId(''), model: 'auto', effort: 'auto' } },
    })
    expect(unset.roles.background.accountId).toBe('')
    render(<WorkLlmSection settings={unset} accounts={[]} patch={() => {}} />)

    expect(screen.getByRole('combobox').textContent).toContain('OpenRouter')
    expect(screen.getByRole('combobox').textContent).not.toContain('Codex')
    // An openrouter 'auto' sends 'auto': no concrete slug to display.
    expect(screen.queryByText(/Effective model:/)).toBeNull()
  })
})
