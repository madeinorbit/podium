import { describe, expect, it, vi } from 'vitest'
import { commandFailureReporter, reportCommandFailures } from './failures'

describe('command failures reach notices', () => {
  it('keeps the returned promise and reports one rejection shared by the write path and caller', async () => {
    const error = new Error('Could not save')
    const notices = { error: vi.fn(), info: vi.fn() }
    const report = commandFailureReporter(notices)
    const pending = Promise.reject(error)
    const records = reportCommandFailures({ edit: () => pending }, report)
    const commands = reportCommandFailures({ rename: () => records.edit() }, report)
    expect(commands.rename()).toBe(pending)
    await expect(pending).rejects.toBe(error)
    expect(notices.error).toHaveBeenCalledExactlyOnceWith('Could not save')
  })

  it('keeps a synchronous launch result and a synchronous refusal unchanged', () => {
    const notices = { error: vi.fn(), info: vi.fn() }
    const result = { sessionId: 'session', settled: Promise.resolve(true) }
    const error = new Error('Refused')
    const commands = reportCommandFailures({ launch: () => result, refuse: () => { throw error } }, commandFailureReporter(notices))
    expect(commands.launch()).toBe(result)
    expect(() => commands.refuse()).toThrow(error)
    expect(notices.error).toHaveBeenCalledExactlyOnceWith('Refused')
  })
})
