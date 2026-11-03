import { asSessionId } from '@podium/model/browser'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { modelCatalogFixture } from '@/test-support/model-catalog-mock'
import { type ModelChipSession, SessionModelChip } from './SessionModelChip'

/**
 * THE SESSION MODEL CHIP (POD-6264).
 *
 * Two faces on one rule: a running session whose driver reported `model` in
 * `configureFields` gets menus that call `sessions.configure` with only the
 * field that changed; every other session gets a readout that says why not.
 */

const configure = vi.hoisted(() => vi.fn())
vi.mock('@/app/keyed-runtime', () => ({
  useRuntimeActions: () => ({ trpc: { sessions: { configure: { mutate: configure } } } }),
}))
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }))

function session(over: Partial<ModelChipSession> = {}): ModelChipSession {
  return {
    sessionId: asSessionId('s1'),
    agentKind: 'claude-code',
    status: 'live',
    model: 'auto',
    effort: 'auto',
    ...over,
  } as ModelChipSession
}

beforeEach(() => {
  configure.mockReset()
  configure.mockResolvedValue({ ok: true, effective: 'next-turn' })
  modelCatalogFixture.current = {
    'claude-code': [
      { value: 'claude-opus-5-5', label: 'Opus 5.5', efforts: ['low', 'high'] },
      { value: 'claude-sonnet-5-5', label: 'Sonnet 5.5', efforts: ['low', 'high'] },
    ],
  }
})
afterEach(() => {
  cleanup()
  modelCatalogFixture.current = {}
})

describe('a session whose driver can change model mid-conversation', () => {
  const configurable = () =>
    session({
      configureFields: ['model', 'effort'],
      observedModel: 'claude-opus-5-5',
      effort: 'high',
    })

  it('offers the model and effort as menus, labelled from the catalog', () => {
    render(<SessionModelChip session={configurable()} />)
    const chip = screen.getByTestId('session-model')
    expect(chip.getAttribute('data-configurable')).toBe('true')
    expect(screen.getByRole('button', { name: 'Model' }).textContent).toBe('Opus 5.5')
    const effort = screen.getByRole('button', { name: 'Effort' }) as HTMLButtonElement
    expect(effort.textContent).toBe('High')
    expect(effort.disabled).toBe(false)
  })

  it('sends only the field that changed', async () => {
    render(<SessionModelChip session={configurable()} />)
    fireEvent.click(screen.getByRole('button', { name: 'Model' }))
    fireEvent.click(await screen.findByRole('menuitem', { name: /Sonnet 5\.5/ }))
    await waitFor(() => expect(configure).toHaveBeenCalledTimes(1))
    expect(configure).toHaveBeenCalledWith({ sessionId: 's1', model: 'claude-sonnet-5-5' })
  })

  it('offers no Use option for a typed model name (moved from the header, POD-3911)', async () => {
    render(<SessionModelChip session={configurable()} />)
    fireEvent.click(screen.getByRole('button', { name: 'Model' }))
    fireEvent.change(await screen.findByPlaceholderText('Filter…'), {
      target: { value: 'my-custom-model' },
    })
    expect(screen.queryByRole('menuitem', { name: /Use / })).toBeNull()
  })

  it('keeps effort inert when the driver reported model but not effort', () => {
    render(
      <SessionModelChip
        session={session({ configureFields: ['model'], observedModel: 'claude-opus-5-5' })}
      />,
    )
    expect((screen.getByRole('button', { name: 'Effort' }) as HTMLButtonElement).disabled).toBe(
      true,
    )
  })

  it('reads as a readout once the session is not running', () => {
    render(<SessionModelChip session={{ ...configurable(), status: 'hibernated' }} />)
    const chip = screen.getByTestId('session-model')
    expect(chip.getAttribute('data-configurable')).toBe('false')
    expect(chip.getAttribute('aria-label')).toContain('Wake it to change')
  })
})

describe('a session that takes its model at launch', () => {
  it('shows the running model as a readout with the reason', () => {
    render(
      <SessionModelChip
        session={session({ configureFields: [], observedModel: 'claude-opus-5-5', effort: 'high' })}
      />,
    )
    const chip = screen.getByTestId('session-model')
    expect(chip.getAttribute('data-configurable')).toBe('false')
    expect(chip.textContent).toBe('Opus 5.5 · High')
    expect(chip.getAttribute('aria-label')).toContain('cannot change mid-conversation')
    expect(screen.queryByRole('button', { name: 'Model' })).toBeNull()
  })

  it('names a model the catalog does not list rather than showing its id', () => {
    render(
      <SessionModelChip
        session={session({ configureFields: [], observedModel: 'claude-haiku-4-5-20251001' })}
      />,
    )
    expect(screen.getByTestId('session-model').textContent).toBe('haiku 4.5')
  })

  it('marks a model not yet seen in the transcript as requested', () => {
    render(
      <SessionModelChip session={session({ configureFields: [], model: 'claude-opus-5-5' })} />,
    )
    expect(screen.getByTestId('session-model').getAttribute('data-provenance')).toBe('requested')
  })

  it('says unknown, not no, when the daemon has not reported', () => {
    render(<SessionModelChip session={session({ observedModel: 'claude-opus-5-5' })} />)
    expect(screen.getByTestId('session-model').getAttribute('aria-label')).toContain(
      'has not reported',
    )
  })
})

it('renders nothing for a session that is not an agent', () => {
  const { container } = render(<SessionModelChip session={session({ agentKind: 'shell' })} />)
  expect(container.textContent).toBe('')
})
