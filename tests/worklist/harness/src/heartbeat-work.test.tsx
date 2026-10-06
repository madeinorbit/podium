// @vitest-environment happy-dom
import { mkdirSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { expect, it } from 'vitest'
import { poolScreenCellsAt } from './pool-screen-work'

// POD-5501 background: fresh web Workspace, open Flight Deck and native
// AgentPanel. Closed menus/link targets retain no catalog demand. Phone,
// Tasks, issue explorer, chat diagnostics, palette, automations and fleet
// panels are absent. The all-screen inventory remains a separate diagnostic.
const LIVE_BACKGROUND_READERS = new Set([
  'sidebar.sections', 'sidebar.row', 'sidebar.worktree', 'sidebar.selection',
  'shell.chrome', 'shell.dock', 'shell.close', 'shell.catalogs',
  'shell.links', 'shell.browserOpen',
  'launcher.launch', 'launcher.window',
  'mission.pane', 'mission.workspace',
  'navigation.activity', 'navigation.mission',
  'session-pane', 'notices', 'preferences',
])

it('one live background heartbeat stays within twice the work at four times the corpus', async () => {
  const at1x = await poolScreenCellsAt(1, undefined, LIVE_BACKGROUND_READERS, ['heartbeat'], 'background-terminal')
  const at4x = await poolScreenCellsAt(4, undefined, LIVE_BACKGROUND_READERS, ['heartbeat'], 'background-terminal')
  const directory = resolve('.artifacts/heartbeat')
  mkdirSync(directory, { recursive: true })
  writeFileSync(resolve(directory, 'heartbeat-work.json'), JSON.stringify({ at1x, at4x }, null, 2) + '\n')
  expect(at4x.readers).toEqual(at1x.readers)
  expect(at1x.readers.map((reader) => reader.name).sort()).toEqual([...LIVE_BACKGROUND_READERS].sort())
  expect(at4x.cells[0]!.neighbourhood.length).toBe(at1x.cells[0]!.neighbourhood.length)
  for (const kind of ['rows', 'derivations', 'elements'] as const) {
    const one = at1x.cells[0]!.work[kind] ?? 0
    const four = at4x.cells[0]!.work[kind] ?? 0
    console.info(`[heartbeat work] ${kind}: ${one} → ${four}`)
    expect.soft(four, kind).toBeLessThanOrEqual(2 * one)
  }
}, 1_800_000)
