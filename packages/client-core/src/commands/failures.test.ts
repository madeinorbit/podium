import { describe, expect, it, vi } from 'vitest'
import { commandFailureReporter, reportCommandFailure } from './failures'

describe('command failures reach notices', () => {
  it('keeps the returned promise and reports one rejection shared by the write path and caller', async () => {
    const error = new Error('Could not save')
    const notices = { error: vi.fn(), info: vi.fn() }
    const report = commandFailureReporter(notices)
    const pending = Promise.reject(error)
    const edit = reportCommandFailure(() => pending, report)
    const rename = reportCommandFailure(() => edit(), report)
    expect(rename()).toBe(pending)
    await expect(pending).rejects.toBe(error)
    expect(notices.error).toHaveBeenCalledExactlyOnceWith('Could not save')
  })

  it('keeps a synchronous launch result and a synchronous refusal unchanged', () => {
    const notices = { error: vi.fn(), info: vi.fn() }
    const result = { sessionId: 'session', settled: Promise.resolve(true) }
    const error = new Error('Refused')
    const report = commandFailureReporter(notices)
    const launch = reportCommandFailure(() => result, report)
    const refuse = reportCommandFailure(() => {
      throw error
    }, report)
    expect(launch()).toBe(result)
    expect(() => refuse()).toThrow(error)
    expect(notices.error).toHaveBeenCalledExactlyOnceWith('Refused')
  })
})
