import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { lazy } from '@podium/mobx-helpers'
import { build } from 'esbuild'
import { autorun, observable, runInAction } from 'mobx'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { BODY_INSTANCE_WARNING_THRESHOLD } from './collections'
import type { MobxPool } from './pool'
import { relationLinks } from './shared/links'
import { type RawRelationReader, rawRelationReaderProblems } from './shared/raw-relation-readers'
import { RawRelationWarnings, takeRawRelationViolations } from './shared/raw-relation-warnings'
import { SCHEMA } from './shared/schema'
import {
  BODY_KINDS,
  bodyOf,
  type EmptyDevice,
  openEmptyDevice,
  putIssueWithBodies,
} from './test-support/empty-device.test.fixture'

const devices: EmptyDevice[] = []
const stops: (() => void)[] = []
afterEach(() => {
  for (const stop of stops.splice(0)) stop()
  for (const device of devices.splice(0)) device.dispose()
  vi.restoreAllMocks()
  vi.unstubAllEnvs()
})

async function emptyDevice() {
  const device = await openEmptyDevice({
    world: (server) => {
      for (let i = 0; i < 30; i++) putIssueWithBodies(server, `i${i}`, { seq: i + 1 })
    },
  })
  devices.push(device)
  return device
}

const warnings = () => vi.spyOn(console, 'warn').mockImplementation(() => {})
const bodyWarnings = (warn: ReturnType<typeof warnings>) =>
  warn.mock.calls.filter(([message]) => String(message).includes('Body read misuse:'))
const rawWarnings = (warn: ReturnType<typeof warnings>) =>
  warn.mock.calls.filter(([message]) => String(message).includes('Raw on-demand relation read:'))

class IssueList {
  @observable accessor visible = BODY_INSTANCE_WARNING_THRESHOLD
  constructor(private readonly pool: MobxPool) {}
  @lazy get descriptions() {
    return Array.from(
      { length: this.visible },
      (_, i) => this.pool.issueObject(`i${i}`).description,
    )
  }
}

describe('body holds per observing view', () => {
  it('a list reading body fields for 30 rows warns once, naming the view and kind', async () => {
    const warn = warnings()
    const device = await emptyDevice()
    const opened = device.observe(
      () => new IssueList(device.pool),
      (view) => view.descriptions,
    )
    await device.untilIdle()
    expect(bodyWarnings(warn)).toEqual([])
    runInAction(() => {
      opened.model.visible = 30
    })
    await device.untilIdle()
    expect(bodyWarnings(warn)).toHaveLength(1)
    expect(bodyWarnings(warn)[0]?.[0]).toContain('IssueList.descriptions')
    expect(bodyWarnings(warn)[0]?.[0]).toContain('issueDescription')
    // Rerenders and another body kind do not repeat the warning for this view.
    runInAction(() => {
      opened.model.visible = 0
    })
    runInAction(() => {
      opened.model.visible = 30
    })
    await device.untilIdle()
    expect(bodyWarnings(warn)).toHaveLength(1)
    expect(rawWarnings(warn)).toEqual([])
    opened.close()
  })

  it('counts live instances across kinds, with independent views even when names match', async () => {
    const warn = warnings()
    const device = await emptyDevice()
    const read = () => {
      for (let i = 0; i < 15; i++) {
        device.pool.collections.held(bodyOf('issueDescription', `i${i}`))
        device.pool.collections.held(bodyOf('issueBrief', `i${i}`))
      }
    }
    stops.push(autorun(read, { name: 'IssueList' }))
    stops.push(autorun(read, { name: 'IssueList' }))
    await device.untilIdle()
    expect(bodyWarnings(warn)).toHaveLength(2)
    expect(bodyWarnings(warn)[0]?.[0]).toContain('issueBrief')
    expect(bodyWarnings(warn)[0]?.[0]).toContain('issueDescription')
  })

  it('catches a list even when individual row views already hold all its cached fields', async () => {
    const warn = warnings()
    const device = await emptyDevice()
    for (let i = 0; i < 30; i++)
      device.observe(
        () => device.pool.issueObject(`i${i}`),
        (issue) => issue.description,
      )
    await device.untilIdle()
    expect(bodyWarnings(warn)).toEqual([])
    const list = new IssueList(device.pool)
    runInAction(() => {
      list.visible = 30
    })
    const opened = device.observe(
      () => list,
      (view) => view.descriptions,
    )
    await device.untilIdle()
    expect(bodyWarnings(warn)).toHaveLength(1)
    expect(bodyWarnings(warn)[0]?.[0]).toContain('IssueList.descriptions')
    opened.close()
  })

  it('an issue page reading six body kinds for one issue stays quiet', async () => {
    const warn = warnings()
    const device = await emptyDevice()
    const page = device.observe(
      () => device.pool.issueObject('i0'),
      (issue) => [issue.description, issue.brief, issue.panel, issue.activityNotes],
    )
    await device.untilIdle()
    for (const kind of BODY_KINDS) expect(device.holds(bodyOf(kind, 'i0'))).toBe(true)
    expect(bodyWarnings(warn)).toEqual([])
    expect(rawWarnings(warn)).toEqual([])
    page.close()
  })

  it('does not accumulate bodies released between reads or count unrelated views together', async () => {
    const warn = warnings()
    const device = await emptyDevice()
    for (let i = 0; i < 30; i++) {
      const page = device.observe(
        () => device.pool.issueObject(`i${i}`),
        (issue) => issue.description,
      )
      await device.untilIdle()
      page.close()
    }
    for (let i = 0; i < 30; i++)
      device.observe(
        () => device.pool.issueObject(`i${i}`),
        (issue) => issue.description,
      )
    await device.untilIdle()
    expect(bodyWarnings(warn)).toEqual([])
  })
})

describe('raw on-demand relation reads', () => {
  it('keeps known readers quiet in tests and reports their follow-up once per development session', async () => {
    const warn = warnings()
    const known: RawRelationReader = {
      reader: 'KnownReader',
      relation: 'issue.startedBy',
      followUp: 'POD-7579',
      file: 'known.ts',
      declaration: 'KnownReader',
    }
    const makeGuard = () =>
      new RawRelationWarnings(
        SCHEMA,
        () => false,
        () => known,
      )
    const read = (guard: RawRelationWarnings) =>
      stops.push(
        autorun(
          () => {
            guard.read('issue', 'i0', 'startedBy')
            guard.read('issue', 'i0', 'startedBy')
          },
          { name: 'KnownReader' },
        ),
      )
    read(makeGuard())
    await Promise.resolve()
    expect(warn).not.toHaveBeenCalled()
    expect(takeRawRelationViolations()).toEqual([])
    vi.stubEnv('NODE_ENV', 'development')
    read(makeGuard())
    read(makeGuard())
    await Promise.resolve()
    expect(rawWarnings(warn)).toHaveLength(1)
    expect(rawWarnings(warn)[0]?.[0]).toContain('Follow-up: POD-7579')
  })

  it('reports every unknown development read', async () => {
    const warn = warnings()
    vi.stubEnv('NODE_ENV', 'development')
    const guard = new RawRelationWarnings(
      SCHEMA,
      () => false,
      () => undefined,
    )
    stops.push(
      autorun(
        () => {
          guard.read('issue', 'i0', 'startedBy')
          guard.read('issue', 'i0', 'startedBy')
        },
        { name: 'NewReader' },
      ),
    )
    await Promise.resolve()
    expect(rawWarnings(warn)).toHaveLength(2)
  })
  it.each([
    'many',
    'size',
    'subset',
    'subsetSize',
    'one',
    'links',
  ] as const)('reports a new observed %s reader, identifying the view and relation', async (method) => {
    const warn = warnings()
    const device = await emptyDevice()
    const read = () => {
      const graph = device.pool.graph
      if (method === 'one') return graph.one('issue', 'i0', 'startedBy')
      if (method === 'links') return relationLinks(graph).issue.sessions.ids('i0')
      if (method === 'subset' || method === 'subsetSize')
        return graph[method]('issue', 'i0', 'pageSessions', 'unarchived')
      return graph[method]('issue', 'i0', 'sessions')
    }
    stops.push(
      autorun(
        () => {
          read()
          read()
        },
        { name: 'RawIssueList' },
      ),
    )
    await device.untilIdle()
    expect(rawWarnings(warn)).toHaveLength(2)
    expect(rawWarnings(warn)[0]?.[0]).toContain('RawIssueList')
    expect(rawWarnings(warn)[0]?.[0]).toContain(
      `issue.${method === 'one' ? 'startedBy' : method.startsWith('subset') ? 'pageSessions' : 'sessions'}`,
    )
    expect(takeRawRelationViolations()).toEqual([
      {
        reader: 'RawIssueList',
        relation: `issue.${method === 'one' ? 'startedBy' : method.startsWith('subset') ? 'pageSessions' : 'sessions'}`,
      },
    ])
  })

  it('does not warn for present relations, imperative reads or holding relation getters', async () => {
    const warn = warnings()
    const device = await emptyDevice()
    device.pool.graph.many('issue', 'i0', 'sessions')
    device.observe(
      () => device.pool.issueObject('i0'),
      (issue) => [issue.sessions.members, issue.startedBy],
    )
    stops.push(autorun(() => device.pool.graph.one('issue', 'i0', 'repo')))
    await device.untilIdle()
    expect(rawWarnings(warn)).toEqual([])
  })
})

it('rejects stale raw-reader exceptions and entries without a follow-up issue', () => {
  expect(
    rawRelationReaderProblems((file) =>
      readFileSync(new URL(file, new URL('../../../', import.meta.url)), 'utf8'),
    ),
  ).toEqual([])
  const entry: RawRelationReader = {
    reader: 'IssueList.descriptions',
    relation: 'issue.descriptionRecords',
    followUp: 'POD-7549',
    file: 'list.ts',
    declaration: 'get descriptions()',
  }
  expect(
    rawRelationReaderProblems(() => 'class IssueList { get descriptions() {} }', [entry]),
  ).toEqual([])
  expect(rawRelationReaderProblems(() => 'class IssueList {}', [entry])).toEqual([
    'IssueList.descriptions -> issue.descriptionRecords: reader is gone from list.ts; remove its raw reader exception',
  ])
  expect(
    rawRelationReaderProblems(() => 'get descriptions()', [{ ...entry, followUp: '' as 'POD-1' }]),
  ).toEqual([
    'IssueList.descriptions -> issue.descriptionRecords: a follow-up POD issue is required',
  ])
})

it('production builds remove both diagnostics and reading 30 bodies never warns', async () => {
  const warn = warnings()
  const output = await build({
    stdin: {
      resolveDir: fileURLToPath(new URL('.', import.meta.url)),
      contents: `
        import { PoolCollections } from './collections'
        import { PoolRelations } from './relations'
        import { modelRelationRead } from './shared/model-relation-read'
        import { autorun } from 'mobx'
        export function read() {
          let holds = 0
          const loader = {
            show: () => { holds++; return () => { holds-- } },
            subscribe: () => () => {}, request: () => {},
            isComplete: () => undefined, wasRefused: () => false,
          }
          const collections = new PoolCollections(() => loader)
          const graph = new PoolRelations({
            index: () => ({ members: () => new Set() }), present: () => true,
            heldBy: () => false, warningsEnabled: () => true,
          })
          const stop = autorun(() => {
            for (let i = 0; i < 30; i++)
              collections.held({ collection: 'issueDescription.ofIssue', args: { issueId: String(i) }, part: 'main' })
            graph.many('issue', 'i0', 'sessions')
          })
          const held = holds
          stop()
          collections.dispose()
          graph.clear()
          const raw = () => graph.many('issue', 'i0', 'sessions')
          return {
            held, remaining: holds, sameReader: modelRelationRead(raw) === raw,
            diagnosticFields: Object.keys(collections).concat(Object.keys(graph)).filter((key) => key.includes('ReadWarnings')),
          }
        }
      `,
      loader: 'ts',
    },
    bundle: true,
    conditions: ['@podium/source'],
    format: 'cjs',
    platform: 'node',
    define: { 'process.env.NODE_ENV': '"production"' },
    logOverride: { 'empty-import-meta': 'silent' },
    write: false,
    treeShaking: true,
  })
  const code = output.outputFiles[0]?.text
  if (code === undefined) throw new Error('the production build returned no output')
  for (const diagnostic of [
    'Body read misuse:',
    'Raw on-demand relation read:',
    'observingViews',
    'BodyReadWarnings',
    'RawRelationWarnings',
  ])
    expect(code).not.toContain(diagnostic)
  const module = { exports: {} as { read(): { held: number; remaining: number } } }
  new Function('module', 'exports', 'require', code)(
    module,
    module.exports,
    createRequire(import.meta.url),
  )
  expect(module.exports.read()).toEqual({
    held: 30,
    remaining: 0,
    sameReader: true,
    diagnosticFields: [],
  })
  await Promise.resolve()
  expect(warn).not.toHaveBeenCalled()
})
