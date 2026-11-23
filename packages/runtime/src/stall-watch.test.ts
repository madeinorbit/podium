import { describe, expect, it } from 'vitest'
import type { QueryCost } from './query-attribution'
import { type BuildStallSummary, createStallWatch, type StallWatchOptions } from './stall-watch'

/**
 * POD-7037. On 2026-11-16 one statement held the server for 203 s over 21 calls
 * in 16 minutes, and it was visible only by aggregating 254 stall lines by hand.
 * These pin the three ways the watch says so itself, and that each one stays
 * rate-limited.
 */

const MINUTE = 60_000
const effects = 'select "id", "kind" … from "effects" #b1660a94'
const sessions = 'select "id" … from "sessions" #c2b01731'

function harness(overrides: Partial<StallWatchOptions> = {}, files: Record<string, string> = {}) {
  let clock = 1_000_000
  const lines: { level: 'info' | 'warn'; message: string; fields: Record<string, unknown> }[] = []
  const watch = createStallWatch({
    build: '0.3.2-dev.18',
    log: {
      info: (message, fields = {}) => lines.push({ level: 'info', message, fields }),
      warn: (message, fields = {}) => lines.push({ level: 'warn', message, fields }),
    },
    now: () => clock,
    nameOf: (key) => (key === effects ? 'apps/server/src/store/effects.ts:292 active' : undefined),
    readFile: (path) => files[path],
    writeFile: (path, contents) => {
      files[path] = contents
    },
    ...overrides,
  })
  return {
    watch,
    lines,
    files,
    advance: (ms: number) => {
      clock += ms
    },
    messages: (message: string) => lines.filter((line) => line.message === message),
  }
}

const window = (...entries: [string, Partial<QueryCost>][]): Map<string, QueryCost> =>
  new Map(entries.map(([key, cost]) => [key, { count: 1, wallMs: 0, rows: 0, ...cost }]))

describe('the hourly digest', () => {
  it('lists the statements with the most stall time, by definition name', () => {
    const h = harness()
    h.watch.noteStall(900, window([effects, { wallMs: 800 }], [sessions, { wallMs: 50 }]))
    h.advance(10 * MINUTE)
    h.watch.noteStall(700, window([effects, { wallMs: 650, readBytes: 50 * 1024 * 1024 }]))
    h.advance(50 * MINUTE)
    h.watch.tick()
    const [digest] = h.messages('server stall digest')
    expect(digest?.level).toBe('info')
    expect(digest?.fields).toMatchObject({ stalls: 2, stallMs: 1600, maxStallMs: 900, minutes: 60 })
    expect(digest?.fields.top).toEqual([
      `2x/1450ms/0rows/50.0MBread [apps/server/src/store/effects.ts:292 active] ${effects}`,
      `1x/50ms/0rows ${sessions}`,
    ])
  })

  it('bounds the list to the top five', () => {
    const h = harness()
    const keys = Array.from({ length: 8 }, (_, i) => `select ${i}`)
    h.watch.noteStall(
      500,
      window(...keys.map((key, i): [string, Partial<QueryCost>] => [key, { wallMs: i }])),
    )
    h.advance(60 * MINUTE)
    h.watch.tick()
    expect(h.messages('server stall digest')[0]?.fields.top).toHaveLength(5)
  })

  it('writes nothing for an hour without stalls, and starts each hour afresh', () => {
    const h = harness()
    h.advance(60 * MINUTE)
    h.watch.tick()
    expect(h.messages('server stall digest')).toEqual([])
    h.watch.noteStall(300, window([sessions, { wallMs: 200 }]))
    h.advance(60 * MINUTE)
    h.watch.tick()
    h.advance(60 * MINUTE)
    h.watch.tick()
    expect(h.messages('server stall digest')).toHaveLength(1)
  })
})

describe('immediate alerts', () => {
  it('warns once an hour when one statement passes 30 s of stall time', () => {
    const h = harness()
    for (let i = 0; i < 4; i++) {
      h.watch.noteStall(9_000, window([effects, { wallMs: 9_000 }]))
      h.advance(MINUTE)
    }
    const alerts = h.messages('statement stall time over budget')
    expect(alerts).toHaveLength(1)
    expect(alerts[0]?.fields).toMatchObject({
      statement: `[apps/server/src/store/effects.ts:292 active] ${effects}`,
      stallMs: 36_000,
      calls: 4,
    })
    h.advance(60 * MINUTE)
    h.watch.tick()
    expect(h.messages('server stall digest')[0]).toMatchObject({
      level: 'warn',
      fields: { statementsOverBudget: 1, longStalls: 4 },
    })
    for (let i = 0; i < 4; i++) h.watch.noteStall(9_000, window([effects, { wallMs: 9_000 }]))
    expect(h.messages('statement stall time over budget')).toHaveLength(2)
  })

  it('warns at the first stall over 5 s of an hour, naming its worst statement', () => {
    const h = harness()
    h.watch.noteStall(4_999, window([sessions, { wallMs: 4_000 }]))
    expect(h.messages('server stall over limit')).toEqual([])
    h.watch.noteStall(23_600, window([sessions, { wallMs: 10 }], [effects, { wallMs: 23_000 }]))
    h.watch.noteStall(6_000, window([effects, { wallMs: 5_900 }]))
    const alerts = h.messages('server stall over limit')
    expect(alerts).toHaveLength(1)
    expect(alerts[0]?.fields).toMatchObject({
      durationMs: 23_600,
      statement: `[apps/server/src/store/effects.ts:292 active] ${effects}`,
      statementMs: 23_000,
    })
  })

  it('warns once per statement for a heavy read, and at most twenty an hour', () => {
    const h = harness()
    const read = (key: string) => ({ key, readBytes: 50 * 1024 * 1024, wallMs: 2_200, rows: 0 })
    h.watch.noteHeavyReads([read(effects), read(effects)])
    const [alert] = h.messages('statement read heavy')
    expect(h.messages('statement read heavy')).toHaveLength(1)
    expect(alert?.fields).toMatchObject({
      statement: `[apps/server/src/store/effects.ts:292 active] ${effects}`,
      read: '50.0MB',
      rows: 0,
      bytesPerRow: 50 * 1024 * 1024,
    })
    h.watch.noteHeavyReads(Array.from({ length: 30 }, (_, i) => read(`select ${i}`)))
    expect(h.messages('statement read heavy')).toHaveLength(20)
  })
})

describe('the post-deploy check', () => {
  const path = '/state/perf/server-stall-builds.json'
  const previous = (stallMs: number, build = '0.3.2-dev.17'): string =>
    JSON.stringify({
      builds: [
        {
          build,
          startedAt: '2026-11-16T15:00:00.000Z',
          windowMinutes: 30,
          stalls: 40,
          stallMs,
          maxStallMs: 900,
        } satisfies BuildStallSummary,
      ],
    })

  it('warns as soon as the new build passes twice the previous build, not at the end', () => {
    const h = harness({ summaryPath: path }, { [path]: previous(20_000) })
    for (let i = 0; i < 13; i++) {
      h.advance(MINUTE)
      h.watch.noteStall(3_000, window())
    }
    // 13 × 3 s = 39 s: past the 30 s floor, not past 2 × 20 s.
    expect(h.messages('post-deploy stall regression')).toEqual([])
    h.watch.noteStall(3_000, window())
    const alerts = h.messages('post-deploy stall regression')
    expect(alerts).toHaveLength(1)
    expect(alerts[0]?.fields).toMatchObject({
      build: '0.3.2-dev.18',
      previousBuild: '0.3.2-dev.17',
      stallMs: 42_000,
      previousStallMs: 20_000,
      ratio: 2.1,
      minutesSinceStart: 13,
    })
    h.watch.noteStall(9_000, window())
    expect(h.messages('post-deploy stall regression')).toHaveLength(1)
  })

  it('keeps quiet under the floor however large the ratio', () => {
    const h = harness({ summaryPath: path }, { [path]: previous(1_000) })
    h.watch.noteStall(25_000, window())
    h.advance(30 * MINUTE)
    h.watch.tick()
    expect(h.messages('post-deploy stall regression')).toEqual([])
    expect(h.messages('post-deploy stall check passed')).toHaveLength(1)
  })

  it('counts only the first thirty minutes', () => {
    const h = harness({ summaryPath: path }, { [path]: previous(20_000) })
    h.advance(30 * MINUTE)
    h.watch.noteStall(90_000, window())
    h.watch.tick()
    expect(h.messages('post-deploy stall regression')).toEqual([])
  })

  it('records the build after its window, keeps the first figure and the last ten builds', () => {
    const older = Array.from({ length: 10 }, (_, i) => ({
      build: `0.3.2-dev.${i}`,
      startedAt: '2026-11-10T00:00:00.000Z',
      windowMinutes: 30,
      stalls: 1,
      stallMs: 100,
      maxStallMs: 100,
    }))
    const files = { [path]: JSON.stringify({ builds: older }) }
    const first = harness({ summaryPath: path }, files)
    first.watch.noteStall(1_200, window())
    first.advance(29 * MINUTE)
    first.watch.tick()
    expect(JSON.parse(files[path]!).builds).toHaveLength(10)
    first.advance(MINUTE)
    first.watch.tick()
    const written = JSON.parse(files[path]!).builds as BuildStallSummary[]
    expect(written).toHaveLength(10)
    expect(written.at(-1)).toMatchObject({ build: '0.3.2-dev.18', stalls: 1, stallMs: 1_200 })
    expect(written[0]?.build).toBe('0.3.2-dev.1')

    // A restart of the same build compares with the build BEFORE it and does
    // not replace the first figure.
    const restart = harness({ summaryPath: path }, files)
    restart.watch.noteStall(40_000, window())
    expect(restart.messages('post-deploy stall regression')[0]?.fields).toMatchObject({
      previousBuild: '0.3.2-dev.9',
    })
    restart.advance(30 * MINUTE)
    restart.watch.tick()
    expect((JSON.parse(files[path]!).builds as BuildStallSummary[]).at(-1)?.stallMs).toBe(1_200)
  })

  it('compares with nothing on the first build, and survives an unreadable file', () => {
    const h = harness({ summaryPath: path }, { [path]: '{not json' })
    h.watch.noteStall(120_000, window())
    h.advance(30 * MINUTE)
    h.watch.tick()
    expect(h.messages('post-deploy stall regression')).toEqual([])
    expect(JSON.parse(h.files[path]!).builds).toHaveLength(1)
  })
})
