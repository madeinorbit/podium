/**
 * The shell's type floor, enforced (POD-783).
 *
 * POD-450 established four semantic type roles and a 10.5px floor for ordinary
 * shell text, and nothing enforced it. Six days later a 44-file theme rewrite
 * walked straight through the floor — the work list's status line fell from
 * 12px to 10.5px and the issue-ID prefix to 6.5px — and neither change is
 * mentioned in that commit's message. It was collateral drift, not a decision,
 * and no test could have told anyone.
 *
 * So: a call site may not invent a sub-floor size. Say it with a role class
 * (`shell-type-micro` is the floor, 10.5px in both densities) and the density
 * switch keeps working; write `text-[9px]` and the shell quietly gets smaller
 * again the next time someone refactors past it.
 *
 * KNOWN_SUB_FLOOR is a debt ledger, not a config. It may only ever SHRINK — if
 * a file drops off the list it must not come back, and nothing new may join.
 */
import { readdirSync, readFileSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const sourceRoot = resolve(import.meta.dirname, '..')

/** Anything below the 10.5px micro role: 6–9.5px written as an arbitrary value. */
const SUB_FLOOR = /text-\[(?:[6-9])(?:\.\d+)?px\]/g

/**
 * Files that still carry pre-POD-783 sub-floor type. Each one is a sweep waiting
 * to happen (POD-784) — convert the call site to a `shell-type-*` role and take
 * the file off this list. Do not add to it.
 */
const KNOWN_SUB_FLOOR = new Set([
  'app/FlightDeck.tsx',
  'app/Workspace.tsx',
  'components/GitStamp.tsx',
  'components/IssueColorSwatches.tsx',
  'components/IssueFleetSummary.tsx',
  'features/chat/AskUserQuestionCard.tsx',
  'features/chat/OfferArtifactStrip.tsx',
  'features/chat/OfferBar.tsx',
  'features/issues/BoardShortcutSheet.tsx',
  'features/issues/IssueCard.tsx',
  'features/issues/IssueCompactControls.tsx',
  'features/issues/IssueListView.tsx',
  'features/issues/IssuePanelView.tsx',
  'features/issues/IssuesKanban.tsx',
  'features/issues/explorer/IssueExplorerList.tsx',
  'features/issues/issue-glyphs.tsx',
  'features/issues/issue-page/DateProperty.tsx',
  'features/issues/issue-page/IssueActivity.tsx',
  'features/issues/issue-page/IssueAgentActivity.tsx',
  'features/issues/issue-page/IssueDetailHeader.tsx',
  'features/issues/issue-page/IssueProperties.tsx',
  'features/issues/issue-page/IssueSessionsBlock.tsx',
  'features/issues/issue-page/IssueSubIssues.tsx',
  'features/machines/QuotaIndicator.tsx',
  'features/merge-queue/MergeQueuePanel.tsx',
  'features/messages/MessageLedgerView.tsx',
  'features/superagent/SuperagentView.tsx',
  'features/terminal/AgentPanel.tsx',
  'features/terminal/SessionWatchers.tsx',
  'lib/menu-surface.ts',
  'lib/motion/AgentStatusGlyph.tsx',
  'lib/motion/MotionDemo.tsx',
])

function productionSources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) return productionSources(path)
    if (!/\.tsx?$/.test(entry.name) || entry.name.includes('.test.')) return []
    return [path]
  })
}

function subFloorSites(): Map<string, string[]> {
  const byFile = new Map<string, string[]>()
  for (const path of productionSources(sourceRoot)) {
    const source = readFileSync(path, 'utf8')
    const hits: string[] = []
    for (const match of source.matchAll(SUB_FLOOR)) {
      const line = source.slice(0, match.index).split('\n').length
      hits.push(`${line}: ${match[0]}`)
    }
    if (hits.length > 0) byFile.set(relative(sourceRoot, path).replaceAll('\\', '/'), hits)
  }
  return byFile
}

describe('shell type floor', () => {
  it('lets no new file drop ordinary text below the 10.5px micro role', () => {
    const offenders = [...subFloorSites().keys()].filter((file) => !KNOWN_SUB_FLOOR.has(file))
    expect(
      offenders,
      `sub-10.5px type in files with no sub-floor debt. Use a shell-type-* role\n` +
        `(shell-type-micro is the 10.5px floor) instead of an arbitrary size:\n` +
        offenders.map((f) => `  ${f}`).join('\n'),
    ).toEqual([])
  })

  it('keeps the debt ledger honest — a swept file must not stay on the list', () => {
    const remaining = subFloorSites()
    const stale = [...KNOWN_SUB_FLOOR].filter((file) => !remaining.has(file))
    expect(
      stale,
      `these files no longer carry sub-floor type — remove them from KNOWN_SUB_FLOOR\n` +
        `so the ledger can never grow back:\n` +
        stale.map((f) => `  ${f}`).join('\n'),
    ).toEqual([])
  })

  /**
   * The stylesheets are the other half of the surface, and the one that let the
   * `label-mono` section label sit at 8.5px unnoticed — a TSX scan never sees a
   * `@utility`. There is one file and no useful per-file allowlist, so this is a
   * plain ratchet: the number may only go down, and it has to be edited down
   * when it does, which is what makes a sweep visible in review.
   */
  const CSS_SUB_FLOOR_BUDGET: Record<string, number> = {
    'index.css': 0,
    'styles.css': 68,
  }

  it.each(Object.entries(CSS_SUB_FLOOR_BUDGET))(
    '%s carries no more than its remaining sub-floor budget',
    (file, budget) => {
      const source = readFileSync(join(sourceRoot, file), 'utf8')
      const hits = [...source.matchAll(/font-size:\s*([0-9]+(?:\.[0-9]+)?)px/g)]
        .filter((m) => Number(m[1]) < 10.5)
        .map((m) => `${source.slice(0, m.index).split('\n').length}: ${m[0]}`)
      expect(
        hits.length,
        hits.length > budget
          ? `${file} gained sub-10.5px font-size rules. Read the size from a ` +
            `--shell-type-* token instead:\n${hits.join('\n')}`
          : `${file} is down to ${hits.length} sub-floor rules — lower ` +
            `CSS_SUB_FLOOR_BUDGET['${file}'] to ${hits.length} to lock the gain in.`,
      ).toBe(budget)
    },
  )

  it('holds the work list itself to the floor', () => {
    // The sidebar is what POD-783 was reported about; it carries no debt.
    const worklist = [...subFloorSites().keys()].filter((file) => file.startsWith('features/worklist/'))
    expect(worklist, `sub-floor type is back in the work list:\n${worklist.join('\n')}`).toEqual([])
  })
})
