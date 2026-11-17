import type { SessionView } from '@podium/client-core/session-values'
import { MobxPool, type SessionModel } from '@podium/client-graph'
import { here } from '@podium/client-graph/lookup'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { Alert } from 'react-native'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ComposerModelLabel } from './ComposerModelLabel'

const source = vi.hoisted(() => ({
  catalog: {} as Record<string, { value: string; label: string }[]>,
  configure: vi.fn(async () => ({ reason: 'not-found-in-transcript' })),
}))
vi.mock('@podium/client-core/react', () => ({
  useModelCatalog: () => source.catalog,
  useHarnessDescriptors: () => ({ served: undefined }),
  useStoreHandle: () => ({
    access: { trpc: { sessions: { configure: { mutate: source.configure } } } },
  }),
}))

let pool: MobxPool
beforeEach(() => {
  pool = new MobxPool({ selectedIssueId: null })
})
afterEach(() => {
  cleanup()
  pool.dispose()
  vi.restoreAllMocks()
  source.catalog = {}
  source.configure.mockClear()
})

function session(patch: Partial<SessionView> = {}): SessionModel {
  const row = {
    sessionId: 'composer-model',
    agentKind: 'claude-code',
    status: 'live',
    model: 'claude-opus-5-5',
    effort: 'medium',
    ...patch,
  } as SessionView
  act(() => {
    pool.apply({
      type: 'update',
      rows: [{ kind: 'session', id: row.sessionId, value: row as never }],
    })
  })
  const model = here(pool.model('session', row.sessionId))
  if (!model) throw new Error('Missing composer session fixture')
  return model
}

describe('composer model info', () => {
  it.each<Pick<SessionView, 'status' | 'configureFields'>>([
    { status: 'live', configureFields: undefined },
    { status: 'live', configureFields: [] },
    { status: 'live', configureFields: ['model', 'effort'] },
    { status: 'hibernated', configureFields: ['model', 'effort'] },
  ])('has no change action for $status with $configureFields', (patch) => {
    const alert = vi.spyOn(Alert, 'alert').mockImplementation(() => {})
    render(<ComposerModelLabel session={session(patch)} />)

    const label = screen.getByTestId('session-model')
    expect(label.textContent).toBe('Opus 5.5 · Medium')
    expect(screen.queryAllByRole('button')).toEqual([])
    expect(label.querySelector('svg')).toBeNull()
    expect(label.getAttribute('aria-label')).toBe('Model and effort: Opus 5.5 · Medium')
    fireEvent.click(label)
    expect(alert).not.toHaveBeenCalled()
    expect(source.configure).not.toHaveBeenCalled()
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('uses shared observed, requested and launch precedence while facts arrive', () => {
    render(<ComposerModelLabel session={session({ effort: 'auto' })} />)
    expect(screen.getByTestId('session-model').textContent).toBe('Opus 5.5')

    const requested = {
      effort: 'auto',
      requestedModel: 'claude-sonnet-4-6',
      requestedEffort: 'high',
    }
    session(requested)
    expect(screen.getByTestId('session-model').textContent).toBe('Sonnet 4.6 · High')

    session({ ...requested, observedModel: 'claude-haiku-4-5-20251001', observedEffort: 'low' })
    expect(screen.getByTestId('session-model').textContent).toBe('Haiku 4.5 · Low')
  })

  it('uses the machine catalog display name and formats unlisted model ids', () => {
    source.catalog = { codex: [{ value: 'gpt-6.1-sol', label: 'GPT 6.1 Sol Custom' }] }
    render(
      <ComposerModelLabel
        session={session({ agentKind: 'codex', model: 'gpt-6.1-sol', effort: 'high' })}
      />,
    )
    expect(screen.getByText('GPT 6.1 Sol Custom · High')).toBeTruthy()
    session({ agentKind: 'codex', model: 'gpt-6.2-sol', effort: 'high' })
    expect(screen.getByTestId('session-model').textContent).toBe('GPT 6.2 Sol · High')
  })

  it('shows effort alone and hides the label when no supported session facts exist', () => {
    const view = render(
      <ComposerModelLabel session={session({ model: undefined, effort: 'high' })} />,
    )
    expect(screen.getByTestId('session-model').textContent).toBe('High')
    session({ model: undefined, effort: 'auto' })
    expect(screen.queryByTestId('session-model')).toBeNull()
    session({ agentKind: 'shell' })
    expect(screen.queryByTestId('session-model')).toBeNull()
    view.rerender(<ComposerModelLabel session={undefined} />)
    expect(screen.queryByTestId('session-model')).toBeNull()
  })
})
