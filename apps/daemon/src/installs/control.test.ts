import { describe, expect, it, vi } from 'vitest'
import type { ControlHandlers, DaemonContext } from '../control/context'
import { installHandlers } from './control'

const pairs = [
  ['install', 'Install'],
  ['check', 'Check'],
  ['back', 'Back'],
  ['pause', 'Pause'],
  ['resume', 'Resume'],
  ['take-settings', 'TakeSettings'],
  ['remove-changes', 'RemoveChanges'],
  ['changes', 'Changes'],
  ['remove', 'Remove'],
  ['home-info', 'HomeInfo'],
  ['remove-home', 'HomeRemove'],
] as const
it.each(pairs)('%s calls the local service and sends its result', async (action, name) => {
  const send = vi.fn()
  const run = vi.fn(async () => ({ ok: true, outcome: 'confirmed' }))
  const ctx = { send, harnessInstalls: { run } } as unknown as DaemonContext
  const handler = installHandlers[
    `harness${name}Request` as keyof typeof installHandlers
  ] as ControlHandlers['harnessHomeRemoveRequest']
  handler(ctx, {
    type: 'harnessHomeRemoveRequest',
    requestId: 'test',
    harness: 'codex',
    confirmedConversations: [],
  })
  await vi.waitFor(() =>
    expect(send).toHaveBeenCalledWith({
      type: `harness${name}Result`,
      requestId: 'test',
      ok: true,
      outcome: 'confirmed',
    }),
  )
  expect(run).toHaveBeenCalledWith(action, 'codex', [])
})
describe('unsupported daemon context', () => {
  it('answers rather than dropping a request', async () => {
    const send = vi.fn()
    installHandlers.harnessInstallRequest({ send } as unknown as DaemonContext, {
      type: 'harnessInstallRequest',
      requestId: 'r',
      harness: 'codex',
    })
    await vi.waitFor(() =>
      expect(send).toHaveBeenCalledWith(
        expect.objectContaining({ ok: false, type: 'harnessInstallResult', requestId: 'r' }),
      ),
    )
  })
})
