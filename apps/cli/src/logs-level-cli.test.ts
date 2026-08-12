import { describe, expect, it, vi } from 'vitest'
import {
  LogsLevelCliError,
  type LogsLevelClient,
  logsLevelHelpText,
  parseLogsLevelArgs,
  parseRaiseDuration,
  renderSetLevelReply,
  runLogsLevelCli,
  type SetLevelReply,
} from './logs-level-cli'

function client(reply: SetLevelReply): LogsLevelClient & { calls: unknown[] } {
  const calls: unknown[] = []
  return {
    calls,
    logs: {
      setLevel: {
        mutate: (input: unknown) => {
          calls.push(input)
          return Promise.resolve(reply as unknown)
        },
      },
    },
  }
}

const TWO_CLIENTS: SetLevelReply = {
  level: 'debug',
  clients: [
    { clientId: 'c3', role: 'web', v: '0.4.1', machineId: 'ludovico' },
    { clientId: 'c7', role: 'mobile' },
  ],
}

const NOBODY: SetLevelReply = { level: 'debug', clients: [] }

// ---------------------------------------------------------------------------
// Durations
// ---------------------------------------------------------------------------

describe('parseRaiseDuration', () => {
  it('accepts s/m/h and converts to milliseconds', () => {
    expect(parseRaiseDuration('90s')).toBe(90_000)
    expect(parseRaiseDuration('30m')).toBe(30 * 60_000)
    expect(parseRaiseDuration('2h')).toBe(2 * 60 * 60_000)
  })
  it('refuses a bare number, so `--for 30` can never mean 30 milliseconds', () => {
    expect(() => parseRaiseDuration('30')).toThrow(LogsLevelCliError)
  })
  it('refuses zero, a negative, and anything past the 24h wire cap', () => {
    expect(() => parseRaiseDuration('0m')).toThrow(LogsLevelCliError)
    expect(() => parseRaiseDuration('-5m')).toThrow(LogsLevelCliError)
    expect(() => parseRaiseDuration('25h')).toThrow(/24h/)
    expect(parseRaiseDuration('24h')).toBe(24 * 60 * 60_000)
  })
})

// ---------------------------------------------------------------------------
// Argument planning
// ---------------------------------------------------------------------------

describe('parseLogsLevelArgs', () => {
  it('`clients` is a reset over every connection, and says so in the plan', () => {
    expect(parseLogsLevelArgs(['clients'])).toEqual({
      kind: 'clients',
      json: false,
      input: { level: null },
    })
  })
  it('`level debug` raises everything with no ttl of its own', () => {
    expect(parseLogsLevelArgs(['level', 'debug'])).toEqual({
      kind: 'raise',
      json: false,
      input: { level: 'debug' },
    })
  })
  it('carries the selector and the duration', () => {
    expect(
      parseLogsLevelArgs(['level', 'trace', '--role', 'web', '--for', '2h', '--json']),
    ).toEqual({
      kind: 'raise',
      json: true,
      input: { level: 'trace', ttlMs: 7_200_000, target: { role: 'web' } },
    })
    expect(parseLogsLevelArgs(['level', 'debug', '--client', 'c3'])).toEqual({
      kind: 'raise',
      json: false,
      input: { level: 'debug', target: { clientId: 'c3' } },
    })
    expect(parseLogsLevelArgs(['level', 'debug', '--machine=m1'])).toEqual({
      kind: 'raise',
      json: false,
      input: { level: 'debug', target: { machineId: 'm1' } },
    })
  })
  it('`level reset` is a null level and keeps the selector', () => {
    expect(parseLogsLevelArgs(['level', 'reset', '--role', 'mobile'])).toEqual({
      kind: 'reset',
      json: false,
      input: { level: null, target: { role: 'mobile' } },
    })
  })
  it('refuses a duration on a reset — there is nothing to expire', () => {
    expect(() => parseLogsLevelArgs(['level', 'reset', '--for', '30m'])).toThrow(/--for/)
  })
  it('names the levels when the level is missing or unknown', () => {
    expect(() => parseLogsLevelArgs(['level'])).toThrow(/error, warn, info, debug, trace/)
    expect(() => parseLogsLevelArgs(['level', 'verbose'])).toThrow(/verbose/)
  })
  it('refuses unknown flags and stray arguments', () => {
    expect(() => parseLogsLevelArgs(['level', 'debug', '--namespace', 'ui'])).toThrow(/--namespace/)
    expect(() => parseLogsLevelArgs(['clients', 'web'])).toThrow(/web/)
  })
  it('refuses a selector flag with no value', () => {
    expect(() => parseLogsLevelArgs(['level', 'debug', '--role'])).toThrow(/--role/)
  })
})

// ---------------------------------------------------------------------------
// Rendering — the reply's reached-list, never a bare ok
// ---------------------------------------------------------------------------

describe('renderSetLevelReply', () => {
  it('lists every connection a raise reached, with what it calls itself', () => {
    const text = renderSetLevelReply('raise', TWO_CLIENTS, { ttlMs: 30 * 60_000 })
    expect(text).toContain('Raised 2 clients to debug for 30m')
    expect(text).toContain('c3  role=web v=0.4.1 machine=ludovico')
    expect(text).toContain('c7  role=mobile')
    expect(text).toContain('logs/clients/')
  })
  it('a raise that reached nobody reads as a failure, not as an ok', () => {
    const text = renderSetLevelReply('raise', NOBODY, {})
    expect(text).toContain('No connected client matched')
    expect(text).not.toMatch(/^Raised/m)
  })
  it('the client listing admits that it also put everyone back', () => {
    const text = renderSetLevelReply('clients', { level: null, clients: TWO_CLIENTS.clients }, {})
    expect(text).toContain('2 clients connected')
    expect(text).toContain('boot default')
  })
  it('reports an empty deployment plainly', () => {
    expect(renderSetLevelReply('clients', { level: null, clients: [] }, {})).toContain(
      'No clients connected',
    )
  })
  it('a reset that matched nothing is not a failure', () => {
    const text = renderSetLevelReply('reset', { level: null, clients: [] }, {})
    expect(text).toContain('already at its default')
  })
})

// ---------------------------------------------------------------------------
// The command
// ---------------------------------------------------------------------------

describe('runLogsLevelCli', () => {
  it('sends the planned input and reports what it reached', async () => {
    const c = client(TWO_CLIENTS)
    const result = await runLogsLevelCli(['level', 'debug', '--role', 'web', '--for', '30m'], c)
    expect(c.calls).toEqual([{ level: 'debug', ttlMs: 1_800_000, target: { role: 'web' } }])
    expect(result.ok).toBe(true)
    expect(result.text).toContain('Raised 2 clients to debug for 30m')
  })
  it('a raise that reached nobody is NOT ok', async () => {
    const result = await runLogsLevelCli(['level', 'debug'], client(NOBODY))
    expect(result.ok).toBe(false)
    expect(result.text).toContain('No connected client matched')
  })
  it('a reset that reached nobody is still ok', async () => {
    const result = await runLogsLevelCli(['level', 'reset'], client({ level: null, clients: [] }))
    expect(result.ok).toBe(true)
  })
  it('--json prints the reply verbatim under the usual envelope', async () => {
    const result = await runLogsLevelCli(['clients', '--json'], client(TWO_CLIENTS))
    expect(JSON.parse(result.text)).toEqual({
      command: 'logs clients',
      ok: true,
      data: TWO_CLIENTS,
    })
  })
  it('--json on a raise that reached nobody carries ok:false', async () => {
    const result = await runLogsLevelCli(['level', 'debug', '--json'], client(NOBODY))
    expect(JSON.parse(result.text).ok).toBe(false)
  })
  it('help needs no server', async () => {
    const mutate = vi.fn()
    const result = await runLogsLevelCli(['level', '--help'], {
      logs: { setLevel: { mutate } },
    })
    expect(mutate).not.toHaveBeenCalled()
    expect(result.text).toBe(logsLevelHelpText())
  })
})

describe('logsLevelHelpText', () => {
  it('documents the three verbs, the selectors and the expiry', () => {
    const text = logsLevelHelpText()
    for (const fragment of [
      'podium logs clients',
      'podium logs level',
      'reset',
      '--role',
      '--machine',
      '--client',
      '--for',
      '30 minutes',
      '24h',
    ])
      expect(text).toContain(fragment)
  })
  it('offers no per-namespace or forwarding-only knob — there is exactly one', () => {
    expect(logsLevelHelpText()).not.toMatch(/--namespace|--forward/)
  })
})
