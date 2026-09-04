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
 * Files that still carry pre-POD-783 sub-floor type. POD-807 cleared this debt;
 * do not add to it.
 */
const KNOWN_SUB_FLOOR = new Set<string>()

/**
 * SANCTIONED sub-floor type — a DECISION, and the opposite of the ledger above.
 *
 * The floor governs ORDINARY SHELL TEXT: the status line, the row title, the
 * thing you read. It was never meant to outlaw the register the shell uses to
 * ANNOTATE that text, and two kinds of annotation cannot honour it:
 *
 *   - COUNT BADGES — a numeral inside a 16px circle. Setting it at 10.5px does
 *     not make it more readable; it makes the badge outgrow the control it is
 *     pinned to.
 *   - MONO MICRO-TOKENS — `deleted`, `epic`, `Current`. Machine voice, set in
 *     uppercase mono beside a title, read as a mark rather than as prose.
 *
 * WHY THIS IS NOT KNOWN_SUB_FLOOR: that list is debt and may only ever shrink.
 * This one is a design decision and may move in either direction — but only by
 * editing this file, which is the review checkpoint the exception exists to
 * force. The per-file COUNT is what keeps it from becoming a blanket pass: a
 * sanctioned file may not quietly grow another sub-floor site, and a file that
 * sweeps one has to lower its number here.
 */
const SANCTIONED_SUB_FLOOR: Record<string, { sites: number; why: string }> = {
  'app/RightRail.tsx': { sites: 1, why: 'unread count badge inside a 16px circle' },
  'app/FlightDeck.tsx': {
    sites: 3,
    why:
      'the spine’s three mono micro-tokens: an issue-note chip’s relation prefix ' +
      '(CONTINUED IN / BLOCKED BY, the small-caps half of a label-and-ref pair, which ' +
      'has to sit BELOW the 10.5px ref it labels or the two stop reading as label and ' +
      'value), the NATIVE badge on a harness subagent row, and the roster’s role ' +
      'column (COORDINATOR / BY SPINE DESIGNER) — 96px of uppercase mono that the ' +
      'floor would turn into a truncation. All three are machine voice beside a title, ' +
      'read as marks rather than as prose, and none of them is ordinary shell text.',
  },
  'features/shipping/ShippingPanel.tsx': {
    sites: 1,
    why: 'step-index badge inside a 16px circle',
  },
  'features/issues/IssueListView.tsx': {
    sites: 2,
    why: 'the `deleted` and `epic` mono row tokens',
  },
  'features/issues/IssueCompactControls.tsx': {
    sites: 2,
    why: 'placement menu: the `Current` mono marker and the mono footnote under it',
  },
}

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
    const offenders = [...subFloorSites().keys()].filter(
      (file) => !KNOWN_SUB_FLOOR.has(file) && SANCTIONED_SUB_FLOOR[file] === undefined,
    )
    expect(
      offenders,
      `sub-10.5px type in files with no sub-floor debt. Use a shell-type-* role\n` +
        `(shell-type-micro is the 10.5px floor) instead of an arbitrary size:\n` +
        offenders.map((f) => `  ${f}`).join('\n'),
    ).toEqual([])
  })

  /**
   * The exception's own guard. Without a count, sanctioning a file for its count
   * badge would licence every future sub-floor size anywhere in it — the whole
   * file would leave the floor, quietly, on the strength of one badge.
   */
  it('holds each sanctioned file to the number of sub-floor sites it declares', () => {
    const found = subFloorSites()
    const drifted = Object.entries(SANCTIONED_SUB_FLOOR)
      .map(([file, { sites, why }]) => ({
        file,
        why,
        declared: sites,
        actual: found.get(file)?.length ?? 0,
      }))
      .filter((row) => row.declared !== row.actual)
    expect(
      drifted,
      `a sanctioned file changed its sub-floor count. Update SANCTIONED_SUB_FLOOR\n` +
        `(down when you sweep one; a rise needs the same argument the entry makes):\n` +
        drifted
          .map((r) => `  ${r.file}: declared ${r.declared}, found ${r.actual} — ${r.why}`)
          .join('\n'),
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
    'styles.css': 0,
  }

  /**
   * DENSE SURFACES the floor does not govern, by selector prefix.
   *
   * The stylesheet half needs the same exception the call-site half does, and it
   * needs it MORE: a self-contained dense surface carries an internal type scale
   * of its own, so flattening it to the floor does not raise it to the floor —
   * it deletes the hierarchy inside it and leaves every line the same size.
   *
   * Scoped by selector rather than counted, because these blocks are read and
   * edited as one design. That is also the limit of the exception: a rule outside
   * them still counts against the budget below, so this cannot be used to smuggle
   * a sub-floor size into ordinary shell chrome.
   */
  const SANCTIONED_CSS_SURFACES: { prefix: RegExp; why: string }[] = [
    {
      prefix: /^\.(hp-|health-popover)/,
      why: 'the quota / performance popover — a dense readout with its own 8.5–10px scale',
    },
    {
      prefix: /^\.calm-reader-path/,
      why: 'the reader header’s centred file path: machine voice, the same mono register as the row tokens',
    },
    {
      prefix: /^\.waterfall-/,
      why:
        'the Flight Deck mission waterfall — a Gantt-style timeline whose labels ' +
        'annotate spans rather than being read as prose, on its own 8–9px mono scale',
    },
  ]

  /** Sub-floor `font-size` declarations, each attributed to the rule that owns it. */
  function cssSubFloorHits(source: string): { selector: string; line: number; decl: string }[] {
    const hits: { selector: string; line: number; decl: string }[] = []
    // Innermost blocks only: `[^{}]` on both sides cannot span a nested rule, so
    // an @media wrapper contributes its inner rules rather than one giant match.
    for (const block of source.matchAll(/([^{}]*)\{([^{}]*)\}/g)) {
      const body = block[2] ?? ''
      for (const decl of body.matchAll(/font-size:\s*([0-9]+(?:\.[0-9]+)?)px/g)) {
        if (Number(decl[1]) >= 10.5) continue
        const selector = (block[1] ?? '').trim().split('\n').pop()?.trim() ?? ''
        const at = (block.index ?? 0) + (block[1]?.length ?? 0) + 1 + (decl.index ?? 0)
        hits.push({ selector, line: source.slice(0, at).split('\n').length, decl: decl[0] })
      }
    }
    return hits
  }

  it.each(
    Object.entries(CSS_SUB_FLOOR_BUDGET),
  )('%s carries no more than its remaining sub-floor budget', (file, budget) => {
    const source = readFileSync(join(sourceRoot, file), 'utf8')
    const hits = cssSubFloorHits(source)
      .filter((hit) => !SANCTIONED_CSS_SURFACES.some((s) => s.prefix.test(hit.selector)))
      .map((hit) => `${hit.line}: ${hit.selector} { ${hit.decl} }`)
    expect(
      hits.length,
      hits.length > budget
        ? `${file} gained sub-10.5px font-size rules outside a sanctioned dense ` +
            `surface. Read the size from a --shell-type-* token instead:\n${hits.join('\n')}`
        : `${file} is down to ${hits.length} sub-floor rules — lower ` +
            `CSS_SUB_FLOOR_BUDGET['${file}'] to ${hits.length} to lock the gain in.`,
    ).toBe(budget)
  })

  /**
   * The sanctioned surfaces have to still EXIST. A renamed `.hp-` block would
   * otherwise leave a prefix here matching nothing, and the exception would read
   * as still load-bearing while guarding an empty set.
   */
  it('keeps every sanctioned CSS surface pointing at rules that exist', () => {
    const source = readFileSync(join(sourceRoot, 'styles.css'), 'utf8')
    const hits = cssSubFloorHits(source)
    const empty = SANCTIONED_CSS_SURFACES.filter(
      (surface) => !hits.some((hit) => surface.prefix.test(hit.selector)),
    ).map((surface) => `${surface.prefix} — ${surface.why}`)
    expect(
      empty,
      `these sanctioned surfaces no longer carry sub-floor type — drop them from\n` +
        `SANCTIONED_CSS_SURFACES so the exception cannot outlive what it excused:\n${empty.join('\n')}`,
    ).toEqual([])
  })

  it('holds the work list itself to the floor', () => {
    // The sidebar is what POD-783 was reported about; it carries no debt.
    const worklist = [...subFloorSites().keys()].filter((file) =>
      file.startsWith('features/worklist/'),
    )
    expect(worklist, `sub-floor type is back in the work list:\n${worklist.join('\n')}`).toEqual([])
  })
})
