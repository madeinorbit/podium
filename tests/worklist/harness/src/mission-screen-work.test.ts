/**
 * POD-5421 — the mission pane, navigation and the folded header, alone, under
 * the structural guard's own script (`pool-screen-work.ts`): every click and
 * single-row delta at 1x and 4x, where only closed mission history and
 * unrelated rows grow. A fix that falls back to walking the mission's history
 * per click, per heartbeat or per lookup fails here in minutes; the full
 * guard (`work-per-change.test.tsx`) still judges every reader together.
 */
import { describe, expect, it } from 'vitest'
import { poolScreenCellsAt } from './pool-screen-work'
import { screenWorkVerdicts } from './screen-work-ratios'

const READERS = new Set([
  'mission.pane',
  'mission.workspace',
  'navigation.activity',
  'navigation.ref',
  'navigation.mission',
  'header.folded',
])

/** Judged: these readers, everything they run, their output comparison, and
 * the runtime's navigation watch. The scripted actions also run other
 * screens' derivations and the engine's own gesture work (the legacy
 * optimism repaint, tab pruning); the full guard judges those. */
const JUDGED = new RegExp(
  `^consumer:(${[...READERS].map((name) => name.replace('.', '\\.')).join('|')})(\\.compare)?(/|$)|^pool projection$`,
)

/** Work inside the sidebar row models, which the folded header reads for its
 * declared progress summary. Their own history walks are the sidebar model's
 * (review findings 8–9), not this screen's. */
const SIDEBAR_MODEL = /\/(IssueModel|SessionModel)@/

describe('mission and navigation per-click work', () => {
  it('no mission, navigation or folded-header reader grows with closed history', async () => {
    const at1x = await poolScreenCellsAt(1, undefined, READERS)
    const at4x = await poolScreenCellsAt(4, undefined, READERS)
    expect(at1x.readers.map(({ name }) => name).sort()).toEqual([...READERS].sort())
    const verdicts = screenWorkVerdicts(at1x.cells, at4x.cells)
    // Every reader produced judged counts, so a rename cannot empty the gate.
    for (const name of READERS)
      expect(verdicts.some((verdict) => verdict.reader === `consumer:${name}`)).toBe(true)
    const failing = verdicts.filter(
      (verdict) =>
        !verdict.passed && JUDGED.test(verdict.reader) && !SIDEBAR_MODEL.test(verdict.reader),
    )
    expect(
      failing.map(
        (v) =>
          `${v.action} ${v.kind} ${v.reader}: ${v.at1x} → ${v.at4x}; neighbourhood ${v.neighbourhood1x} → ${v.neighbourhood4x}`,
      ),
    ).toEqual([])
  }, 1_800_000)

  it('the navigation watch keeps its activity roll-ups across clicks', async () => {
    // Only the runtime's navigation watch observes activity here, as in the
    // app. A watch released before its replacement attaches drops the cached
    // roll-ups, and every click re-reads the mission's history.
    const only = new Set(['navigation.mission'])
    const at1x = await poolScreenCellsAt(1, undefined, only)
    const at4x = await poolScreenCellsAt(4, undefined, only)
    const verdicts = screenWorkVerdicts(at1x.cells, at4x.cells)
    const WATCH = /^(pool projection$|NavigationActivity@|SessionSeat@|Seats\.|Mission@)/
    // The menu and long-press gestures are other screens' (their whole-table
    // reads queue cold loads that wake every observer at 4x); the full guard
    // judges them. Every navigation click and single-row delta is judged here.
    const FOREIGN = new Set(['open-menu', 'long-press'])
    expect(verdicts.some((verdict) => WATCH.test(verdict.reader) && verdict.at1x > 0)).toBe(true)
    expect(
      verdicts
        .filter(
          (verdict) =>
            !verdict.passed && WATCH.test(verdict.reader) && !FOREIGN.has(verdict.action),
        )
        .map((v) => `${v.action} ${v.kind} ${v.reader}: ${v.at1x} → ${v.at4x}`),
    ).toEqual([])
  }, 1_800_000)
})
