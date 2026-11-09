import { asSessionId } from '@podium/model/browser'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { runInAction } from 'mobx'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { modelCatalogFixture } from '@/test-support/model-catalog-mock'
import { type ModelChipSession, SessionModelChip } from './SessionModelChip'

/**
 * THE SESSION MODEL CHIP (POD-6264).
 *
 * Two faces on one rule: a running session whose driver reported `model` in
 * `configureFields` gets menus that write a `session.configure` effect record
 * with only the field that changed (POD-6523); every other session gets a
 * readout that says why not.
 */

const configure = vi.hoisted(() => vi.fn())
const toasts = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn() }))
/** The session's latest `session.configure` record, as the pool's model reads. */
const { record, held } = vi.hoisted(() => {
  const { observable } = require('mobx') as typeof import('mobx')
  return {
    record: observable.box<Record<string, unknown> | undefined>(undefined, { deep: false }),
    /** The pool's effect table, which `awaitEffect` reads. */
    held: observable.map<string, Record<string, unknown>>({}, { deep: false }),
  }
})
vi.mock('@/app/store', () => ({
  readFixture: (pick: (s: { configureSession: typeof configure }) => unknown) =>
    pick({ configureSession: configure }),
}))
vi.mock('@/app/store-worklist-pool', () => ({
  useWorklistPool: () => ({
    sessionObject: () => ({
      get configureChange() {
        return record.get()
      },
    }),
    tables: { effect: held },
    model: (_entity: string, id: string) => held.get(id),
  }),
}))
vi.mock('sonner', () => ({ toast: toasts }))

/** The latest record as the feed brings it: on the session, and in the pool's table. */
function show(value: Record<string, unknown>): void {
  runInAction(() => {
    record.set(value)
    held.set(value.id as string, value)
  })
}

function change(over: Record<string, unknown>): Record<string, unknown> {
  const status = (over.status as string | undefined) ?? 'pending'
  return {
    id: 'eff_1',
    kind: 'session.configure',
    input: { model: 'claude-sonnet-5-5' },
    createdAt: '2026-11-06T12:00:00.000Z',
    inFlight: status === 'pending' || status === 'running',
    ...over,
    status,
  }
}

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
  configure.mockResolvedValue('eff_1')
  toasts.success.mockReset()
  toasts.error.mockReset()
  runInAction(() => {
    record.set(undefined)
    held.clear()
  })
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

  it('draws each half as a selector: glyph, value, chevron', () => {
    render(<SessionModelChip session={configurable()} />)
    const model = screen.getByRole('button', { name: 'Model' })
    const effort = screen.getByRole('button', { name: 'Effort' })
    expect(model.querySelector('.lucide-cpu')).not.toBeNull()
    expect(model.querySelector('.lucide-chevron-down')).not.toBeNull()
    expect(effort.querySelector('.lucide-gauge')).not.toBeNull()
    expect(effort.querySelector('.lucide-chevron-down')).not.toBeNull()
  })

  it('sends only the field that changed', async () => {
    render(<SessionModelChip session={configurable()} />)
    fireEvent.click(screen.getByRole('button', { name: 'Model' }))
    fireEvent.click(await screen.findByRole('menuitem', { name: /Sonnet 5\.5/ }))
    await waitFor(() => expect(configure).toHaveBeenCalledTimes(1))
    expect(configure).toHaveBeenCalledWith('s1', { model: 'claude-sonnet-5-5' })
  })

  it('shows the chosen model while the change is on its way, then the record says how it ended', async () => {
    const { rerender } = render(<SessionModelChip session={configurable()} />)
    fireEvent.click(screen.getByRole('button', { name: 'Model' }))
    fireEvent.click(await screen.findByRole('menuitem', { name: /Sonnet 5\.5/ }))
    // Before any record: what was asked for paints at once.
    expect(screen.getByRole('button', { name: 'Model' }).textContent).toBe('Sonnet 5.5')
    expect(screen.getByTestId('session-model').getAttribute('data-pending')).toBe('true')
    await waitFor(() => expect(configure).toHaveBeenCalledTimes(1))
    // The record arrives pending: still the asked-for model, from the record.
    show(change({ status: 'pending' }))
    expect(screen.getByRole('button', { name: 'Model' }).textContent).toBe('Sonnet 5.5')
    // The driver granted it: the session row now names it, and it is said once.
    show(change({ status: 'succeeded', result: { ok: true, effective: 'now' } }))
    rerender(
      <SessionModelChip
        session={{ ...configurable(), requestedModel: 'claude-sonnet-5-5' } as ModelChipSession}
      />,
    )
    await waitFor(() => expect(toasts.success).toHaveBeenCalledWith('The running session changed.'))
    expect(screen.getByTestId('session-model').getAttribute('data-pending')).toBeNull()
    expect(screen.getByRole('button', { name: 'Model' }).textContent).toBe('Sonnet 5.5')
  })

  it("says the driver's refusal and shows the session's own model again", async () => {
    configure.mockResolvedValue('eff_2')
    render(<SessionModelChip session={configurable()} />)
    fireEvent.click(screen.getByRole('button', { name: 'Model' }))
    fireEvent.click(await screen.findByRole('menuitem', { name: /Sonnet 5\.5/ }))
    await waitFor(() => expect(configure).toHaveBeenCalledTimes(1))
    show(
      change({
        id: 'eff_2',
        status: 'failed',
        error: { code: 'refused', message: 'refused' },
        result: { reason: 'refused', detail: 'That model is not available here.' },
      }),
    )
    await waitFor(() =>
      expect(toasts.error).toHaveBeenCalledWith('That model is not available here.'),
    )
    expect(screen.getByRole('button', { name: 'Model' }).textContent).toBe('Opus 5.5')
  })

  it('tells nothing about a change another device asked for', async () => {
    show(change({ id: 'eff_other', status: 'succeeded', result: { ok: true } }))
    render(<SessionModelChip session={configurable()} />)
    await Promise.resolve()
    expect(toasts.success).not.toHaveBeenCalled()
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
    const effort = screen.getByRole('button', { name: 'Effort' }) as HTMLButtonElement
    expect(effort.disabled).toBe(true)
    // Nothing opens, so no chevron promises it.
    expect(effort.querySelector('.lucide-chevron-down')).toBeNull()
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
    // The readout keeps its plain face: no glyph, no chevron.
    expect(chip.querySelector('svg')).toBeNull()
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
