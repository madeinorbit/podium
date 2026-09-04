import { describe, expect, it, vi } from 'vitest'
import type { LaunchPlan } from './launch-configuration'
import { startConfiguredIssue } from './configured-issue-launch'

const plan: LaunchPlan = {
  configuration: {
    agentKind: 'codex',
    modelPick: 'auto',
    effort: 'auto',
    machineId: '',
  },
}

function api(options: { neverStarted?: boolean } = {}) {
  const calls: string[] = []
  const update = vi.fn(async () => {
    calls.push('update')
  })
  const addSession = vi.fn(async () => {
    calls.push('addSession')
    if (options.neverStarted) throw new Error('issue not started')
  })
  const start = vi.fn(async () => {
    calls.push('start')
  })
  return {
    calls,
    update,
    addSession,
    start,
    client: {
      update: { mutate: update },
      addSession: { mutate: addSession },
      start: { mutate: start },
    },
  }
}

describe('startConfiguredIssue', () => {
  it.each([
    'live checkout',
    'freed previously-started checkout',
  ])('persists the normalized profile before addSession for a %s', async () => {
    const fixture = api()
    await startConfiguredIssue(fixture.client, 'issue-1', plan)
    expect(fixture.calls).toEqual(['update', 'addSession'])
    expect(fixture.start).not.toHaveBeenCalled()
  })

  it('falls back to start only when addSession says the issue was never started', async () => {
    const fixture = api({ neverStarted: true })
    await startConfiguredIssue(fixture.client, 'issue-1', plan)
    expect(fixture.calls).toEqual(['update', 'addSession', 'start'])
  })

  it('refuses an unavailable selection before persisting or spawning', async () => {
    const fixture = api()
    await expect(
      startConfiguredIssue(fixture.client, 'issue-1', {
        ...plan,
        refusal: 'Host A is offline.',
      }),
    ).rejects.toThrow('Host A is offline.')
    expect(fixture.calls).toEqual([])
  })
})
