import { beforeEach, describe, expect, it } from 'vitest'
import {
  clearTerminalDiagnostics,
  createTerminalDiagnosticRecorder,
  setTerminalDiagnosticsConsole,
  terminalDiagnosticsSnapshot,
} from './terminal-diagnostics'

beforeEach(() => {
  clearTerminalDiagnostics()
  setTerminalDiagnosticsConsole(false)
})

describe('terminal lifecycle diagnostics', () => {
  it('keeps mount and session identity while filtering snapshots', () => {
    const a = createTerminalDiagnosticRecorder('a')
    const b = createTerminalDiagnosticRecorder('b')
    a.record('mount', { active: true })
    b.record('mount', { active: false })

    expect(terminalDiagnosticsSnapshot('a')).toMatchObject([
      { sessionId: 'a', mountId: a.mountId, event: 'mount', data: { active: true } },
    ])
    expect(terminalDiagnosticsSnapshot()).toHaveLength(2)
  })

  it('returns defensive copies and keeps only the newest 500 events', () => {
    const recorder = createTerminalDiagnosticRecorder('s1')
    for (let i = 0; i < 505; i += 1) recorder.record('fit', { i, nested: { value: i } })

    const snapshot = terminalDiagnosticsSnapshot('s1')
    expect(snapshot).toHaveLength(500)
    expect(snapshot[0]?.data).toEqual({ i: 5, nested: { value: 5 } })
    snapshot[0]!.data.i = 999
    ;(snapshot[0]!.data.nested as { value: number }).value = 999
    expect(terminalDiagnosticsSnapshot('s1')[0]?.data).toEqual({ i: 5, nested: { value: 5 } })
  })

  it('installs a global post-failure inspection API', () => {
    const recorder = createTerminalDiagnosticRecorder('s1')
    recorder.record('reveal:start')

    expect(globalThis.__podiumTerminalDiagnostics?.snapshot('s1')).toMatchObject([
      { sessionId: 's1', event: 'reveal:start' },
    ])
    globalThis.__podiumTerminalDiagnostics?.clear()
    expect(terminalDiagnosticsSnapshot()).toEqual([])
  })
})
