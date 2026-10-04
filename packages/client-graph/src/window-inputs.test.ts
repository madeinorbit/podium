import type { Store } from '@podium/client-core/engine'
import { asSessionId } from '@podium/model/browser'
import { autorun } from 'mobx'
import { describe, expect, it } from 'vitest'
import { inputFixture, inputMechanisms } from '../diagnostics/input-mechanisms'
import { COMMAND_LAUNCH_SCHEMA } from './command-launch-schema'
import { HEADER_SCHEMA } from './header-schema'
import { MOBILE_SESSION_SCHEMA } from './mobile-session-schema'
import { MobxPool } from './pool'
import { SHELL_SCHEMA } from './shell-schema'
import { LOADING } from './worklist/rollup'

const flush = async () => {
  for (let turn = 0; turn < 6; turn++) await Promise.resolve()
}
const zero = (keys: readonly string[]) => Object.fromEntries(keys.map((key) => [key, 0]))

/** The declaration is the guard's reader contract. Every declared field has a
 * reader; changing it must run that reader once and leave all others asleep. */
function observeFields(fields: readonly string[], read: () => unknown) {
  const runs = zero(fields)
  const stops = fields.map((field) =>
    autorun(() => {
      runs[field] = (runs[field] ?? 0) + 1
      const row = read()
      if (row && row !== LOADING) Reflect.get(row as object, field)
    }),
  )
  return {
    runs,
    reset: () => {
      for (const field of fields) runs[field] = 0
    },
    dispose: () => {
      for (const stop of stops) stop()
    },
  }
}

describe('declared window input readers', () => {
  it('keeps repo fields separate from each other and from lane changes, including takeover after replace', () => {
    const pool = new MobxPool({ selectedIssueId: null, coarseNow: 0 })
    const first = { path: '/r/one', repoId: 'r', repoPath: '/r', prefix: 'ONE', branch: 'main' }
    const second = { ...first, path: '/r/two' }
    pool.apply({
      type: 'replace',
      rows: [first, second].map((value) => ({
        kind: 'worktree',
        id: value.path,
        value: value as never,
      })),
    })
    const fields = ['id', 'prefix', 'repoPath'] as const
    const meter = observeFields(fields, () => pool.row('repo', 'r'))
    try {
      const row = pool.row('repo', 'r')
      const update = (value: typeof second) =>
        pool.apply({
          type: 'update',
          rows: [{ kind: 'worktree', id: value.path, value: value as never }],
        })
      meter.reset()
      update({ ...second, branch: 'topic' })
      expect(meter.runs).toEqual(zero(fields))
      expect(pool.row('repo', 'r')).toBe(row)
      meter.reset()
      update({ ...second, prefix: 'TWO' })
      expect(meter.runs).toEqual({ id: 0, prefix: 1, repoPath: 0 })
      meter.reset()
      update({ ...second, prefix: 'TWO', repoPath: '/new' })
      expect(meter.runs).toEqual({ id: 0, prefix: 0, repoPath: 1 })
      // The lane owner survives replace staging; removing it adopts the other lane.
      meter.reset()
      pool.apply({
        type: 'update',
        rows: [{ kind: 'worktree', id: second.path, value: undefined }],
      })
      expect(pool.row('repo', 'r')).toMatchObject({ prefix: 'ONE', repoPath: '/r' })
      expect(meter.runs).toEqual({ id: 0, prefix: 1, repoPath: 1 })
      pool.apply({ type: 'update', rows: [{ kind: 'worktree', id: first.path, value: undefined }] })
      expect(pool.row('repo', 'r')).toBeUndefined()
    } finally {
      meter.dispose()
      pool.dispose()
    }
  })

  it.each([
    1, 4,
  ] as const)('invalidates only the written shell/header/command/mobile field (%sx)', async (scale) => {
    const fixture = inputFixture(scale)
    const { f } = fixture
    const patches: Partial<Store> = {
      view: 'settings',
      paneA: asSessionId('other-pane'),
      selectedIssueId: null,
      selectedWorktree: '/other',
      reposLoaded: false,
      superOpen: false,
      paletteOpen: false,
      autoContinuePromptSessionId: null,
      coarseNow: 60_000,
      fileTabs: [],
      outboxSize: 1,
      pins: ['one'] as never,
      openIssueId: 'other-issue' as never,
      recentFiles: [{ path: 'one' }] as never,
      sidebarSettings: { showClosed: true } as never,
    }
    const sources = [
      {
        fields: SHELL_SCHEMA.shellWindow.fields,
        read: () => f.pool.row('shellWindow', 'window'),
        write: f.change,
      },
      {
        fields: HEADER_SCHEMA.window.fields,
        read: () => f.pool.row('window', 'window'),
        write: fixture.change,
      },
      {
        fields: COMMAND_LAUNCH_SCHEMA.commandWindow.fields,
        read: () => f.pool.row('commandWindow', 'window'),
        write: fixture.change,
      },
    ]
    try {
      for (const source of sources) {
        const meter = observeFields(source.fields, source.read)
        try {
          for (const field of source.fields) {
            // Each source sees a fresh value, even if another source shares a key.
            const old = fixture.state()[field as keyof Store]
            const value = Object.is(old, patches[field as keyof Store])
              ? `${String(old)}-next`
              : patches[field as keyof Store]
            meter.reset()
            source.write({ [field]: value } as Partial<Store>)
            await flush()
            expect(meter.runs, field).toEqual({ ...zero(source.fields), [field]: 1 })
          }
        } finally {
          meter.dispose()
        }
      }
      f.pool.row('mobileSessionWindow', 'window')
      await flush()
      const mobile = observeFields(MOBILE_SESSION_SCHEMA.mobileSessionWindow.fields, () =>
        f.pool.row('mobileSessionWindow', 'window'),
      )
      try {
        mobile.reset()
        fixture.cursor(1)
        await flush()
        expect(mobile.runs).toEqual({ cursor: 1, pendingSpawnPrompts: 0 })
        mobile.reset()
        fixture.change({ pendingSpawnPrompts: new Map([[asSessionId('pending'), 'prompt']]) })
        await flush()
        expect(mobile.runs).toEqual({ cursor: 0, pendingSpawnPrompts: 1 })
      } finally {
        mobile.dispose()
      }
    } finally {
      fixture.dispose()
    }
  })

  it('keeps the already-keyed issue exit signal addressed', () => {
    const fixture = inputFixture(1)
    const first = fixture.f.issues[0]!.id,
      second = fixture.f.issues[1]!.id
    const meter = { first: 0, second: 0 }
    const stops = [
      autorun(() => {
        meter.first++
        fixture.f.pool.row('issueExit', first)
      }),
      autorun(() => {
        meter.second++
        fixture.f.pool.row('issueExit', second)
      }),
    ]
    try {
      meter.first = meter.second = 0
      fixture.issueBatch(first)
      expect(meter).toEqual({ first: 1, second: 0 })
    } finally {
      for (const stop of stops) stop()
      fixture.dispose()
    }
  })

  it('counts the same addressed work at 1x and 4x, including hidden and preference readers', async () => {
    const results = [await inputMechanisms(1), await inputMechanisms(4)]
    for (const result of results) {
      const empty = zero(Object.keys(result.shell))
      expect(result.shell).toEqual({ ...empty, 'shell.chrome': 1 })
      expect(result.header).toEqual({ ...empty, 'header.outbox': 1 })
      expect(result.commands).toEqual({ ...empty, 'command.pins': 1 })
      expect(result.sessions).toEqual({ ...empty, 'mobile.cursor': 1 })
      expect(result.repo).toEqual(empty)
      expect(result.hiddenProjection).toEqual({ reads: 0, comparisons: 0 })
      expect(result.preferenceReads).toBe(1)
    }
    // These scripts address the same one-field neighbourhood at both scales.
    // A zero at 1x requires zero at 4x; otherwise the allowed ratio is 1.
    for (const [action, at1x] of Object.entries(results[0]!.work)) {
      const at4x = results[1]!.work[action]!
      expect(at4x.derivations, action).toBeLessThanOrEqual(at1x.derivations)
      expect(at4x.rowReads, action).toBeLessThanOrEqual(at1x.rowReads)
    }
    console.info('[window input work]', JSON.stringify(results))
  })
})
