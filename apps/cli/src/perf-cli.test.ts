import { describe, expect, it, vi } from 'vitest'
import { helpText } from './cli'
import {
  PERF_EXIT_LEVEL_TOO_LOW,
  PERF_EXIT_NO_PROFILE,
  PERF_EXIT_REFUSED,
  type PerfCliDeps,
  PerfCliError,
  runPerfCli,
} from './perf-cli'

/** A perf install in a directory that need not exist: nothing here touches disk. */
function deps(over: Partial<PerfCliDeps> = {}): PerfCliDeps & {
  signals: Array<[number, string]>
  requests: Array<[string, number]>
} {
  const signals: Array<[number, string]> = []
  const requests: Array<[string, number]> = []
  let clock = 1_000_000
  return {
    perfDir: '/state/perf',
    level: () => ({ level: 'attribution', source: 'config' }),
    pid: () => 4242,
    signal: (pid, sig) => {
      signals.push([pid, sig])
    },
    listProfiles: () => [],
    readProfile: () => '{}',
    writeRequest: (dir, seconds) => {
      requests.push([dir, seconds])
    },
    // Time only moves when the command sleeps, so the poll loop's deadline is
    // reached in microseconds rather than in the 25 s it describes.
    now: () => clock,
    sleep: async (ms) => {
      clock += ms
    },
    signals,
    requests,
    ...over,
  }
}

describe('podium perf level', () => {
  it('prints the level and the layer that decided it', async () => {
    const result = await runPerfCli(
      ['level'],
      deps({ level: () => ({ level: 'full', source: 'env' }) }),
    )
    expect(result.output).toBe('level=full source=env')
    expect(result.exitCode).toBeUndefined()
  })

  it('prints the same pair as JSON', async () => {
    const result = await runPerfCli(['level', '--json'], deps())
    expect(JSON.parse(result.output)).toEqual({ level: 'attribution', source: 'config' })
  })
})

describe('podium perf paths', () => {
  it('prints both minute files and the profile directory, one per line', async () => {
    const result = await runPerfCli(['paths'], deps())
    expect(result.output.split('\n')).toEqual([
      '/state/perf/loop-server.ndjson',
      '/state/perf/loop-daemon.ndjson',
      '/state/perf/profiles',
    ])
  })

  it('prints them keyed as JSON', async () => {
    const result = await runPerfCli(['paths', '--json'], deps())
    expect(JSON.parse(result.output)).toEqual({
      minutes: {
        server: '/state/perf/loop-server.ndjson',
        daemon: '/state/perf/loop-daemon.ndjson',
      },
      profiles: '/state/perf/profiles',
    })
  })
})

describe('podium perf profile', () => {
  it('signals the live pid and prints the file that appeared', async () => {
    const seen: string[][] = [
      ['server-2026-09-10T11-00-00.000Z-stall.json'],
      ['server-2026-09-10T11-00-00.000Z-stall.json'],
      ['server-2026-09-10T11-00-00.000Z-stall.json', 'server-2026-09-10T12-00-00.000Z-signal.json'],
    ]
    const d = deps({ listProfiles: () => seen.shift() ?? [] })

    const result = await runPerfCli(['profile', 'server'], d)

    expect(result.exitCode).toBeUndefined()
    expect(result.output).toBe('/state/perf/profiles/server-2026-09-10T12-00-00.000Z-signal.json')
    expect(d.signals).toEqual([[4242, 'SIGUSR2']])
    expect(d.requests).toEqual([['/state/perf', 10]])
  })

  it('carries --seconds through the request file', async () => {
    const d = deps({ listProfiles: () => ['server-2026-09-10T12-00-00.000Z-signal.json'] })
    // The pre-signal listing is the same file, so it must NOT be reported.
    await runPerfCli(['profile', 'server', '--seconds', '30'], d)
    expect(d.requests).toEqual([['/state/perf', 30]])
  })

  it('never reports a profile that already existed before the signal', async () => {
    const d = deps({ listProfiles: () => ['daemon-2026-09-10T12-00-00.000Z-signal.json'] })
    const result = await runPerfCli(['profile', 'daemon'], d)
    expect(result.exitCode).toBe(PERF_EXIT_NO_PROFILE)
  })

  it('prints why the process refused, rather than a path to a file with no stacks', async () => {
    // A refusal IS a file, so the poll finds one and would otherwise report it
    // as a successful capture. The reason is the whole content (POD-3834).
    const d = deps({
      listProfiles: () => ['server-2026-09-10T12-00-00.000Z-signal.json'],
      readProfile: () =>
        JSON.stringify({
          refused: 'the sampler would run at 1000us, which nothing asked for',
          sampleIntervalUs: 1000,
        }),
    })
    const seen = [[], ['server-2026-09-10T12-00-00.000Z-signal.json']]
    d.listProfiles = () => (seen.shift() as string[]) ?? []

    const result = await runPerfCli(['profile', 'server'], d)

    expect(result.exitCode).toBe(PERF_EXIT_REFUSED)
    expect(result.output).toContain('the server refused')
    expect(result.output).toContain('nothing asked for')
    expect(result.output).toContain('server-2026-09-10T12-00-00.000Z-signal.json')
  })

  it('ignores a stall profile written while it waits for its signal one', async () => {
    const d = deps({ listProfiles: () => ['server-2026-09-10T12-00-00.000Z-stall.json'] })
    const result = await runPerfCli(['profile', 'server'], d)
    expect(result.exitCode).toBe(PERF_EXIT_NO_PROFILE)
  })

  it('exits 2 below attribution, naming the level and how to raise it', async () => {
    for (const level of ['off', 'accounting'] as const) {
      const d = deps({ level: () => ({ level, source: 'default' }) })
      const result = await runPerfCli(['profile', 'server'], d)
      expect(result.exitCode).toBe(PERF_EXIT_LEVEL_TOO_LOW)
      expect(result.output).toContain(`level=${level}`)
      expect(result.output).toContain('config.loopProfile')
      expect(result.output).toContain('PODIUM_LOOP_PROFILE')
      // Nothing was asked of the process: no signal, no request file.
      expect(d.signals).toEqual([])
      expect(d.requests).toEqual([])
    }
  })

  it('exits 3 when nothing appears within seconds + 15', async () => {
    const slept: number[] = []
    let clock = 0
    const d = deps({
      now: () => clock,
      sleep: async (ms) => {
        slept.push(ms)
        clock += ms
      },
    })

    const result = await runPerfCli(['profile', 'server', '--seconds', '5'], d)

    expect(result.exitCode).toBe(PERF_EXIT_NO_PROFILE)
    expect(result.output).toContain('20s')
    // 20 s of polling at 250 ms, and it stopped at the deadline rather than run on.
    expect(slept.length).toBe(80)
  })

  it('refuses a component it does not know and one that is not running', async () => {
    await expect(runPerfCli(['profile', 'janitor'], deps())).rejects.toBeInstanceOf(PerfCliError)
    await expect(runPerfCli(['profile'], deps())).rejects.toBeInstanceOf(PerfCliError)
    await expect(runPerfCli(['profile', 'daemon'], deps({ pid: () => undefined }))).rejects.toThrow(
      /no live daemon/,
    )
  })

  it('refuses a --seconds outside 1–60 before signalling anything', async () => {
    for (const bad of ['0', '61', 'soon', '']) {
      const d = deps()
      await expect(runPerfCli(['profile', 'server', '--seconds', bad], d)).rejects.toBeInstanceOf(
        PerfCliError,
      )
      expect(d.signals).toEqual([])
    }
  })
})

describe('podium perf discovery', () => {
  it('renders its own help and rejects an unknown command', async () => {
    expect((await runPerfCli([], deps())).output).toContain('podium perf <command>')
    expect((await runPerfCli(['--help'], deps())).output).toContain('level [--json]')
    await expect(runPerfCli(['minutes'], deps())).rejects.toBeInstanceOf(PerfCliError)
  })

  it('is listed in podium --help only when podium-development is on', async () => {
    expect(helpText(new Set())).not.toContain('perf <command>')
    expect(helpText(new Set(['workflows', 'specs']))).not.toContain('perf <command>')
    const listed = helpText(new Set(['podium-development']))
    expect(listed).toContain('  perf <command>        Loop profile level, minute files')
    // It belongs under Lifecycle, next to the other things that read a process.
    expect(listed.indexOf('Lifecycle:')).toBeLessThan(listed.indexOf('perf <command>'))
    expect(listed.indexOf('perf <command>')).toBeLessThan(listed.indexOf('Access:'))
  })
})
