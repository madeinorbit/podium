import {
  rowWaitingCount,
  type UnifiedIssueRow,
  type UnifiedWorkGroup,
  type UnifiedWorkRow,
} from '@podium/client-core/viewmodels'

/**
 * THE WORK TAB'S SECTION PROJECTION — pinned first, then the asks, then the
 * project bands [POD-338, POD-724].
 *
 * The rows come from the published worklist slice the desktop sidebar reads
 * (POD-331); this module only decides which BAND each row appears in and in
 * what band order. Source order inside every band is preserved, and reordering
 * still writes in the original pinned/project scope (`orderingSections`).
 *
 * PINNED LEADS. Pinning is the operator's own "this stays under my thumb", so
 * the band sits above even Needs You — and a pinned row NEVER leaves it. The
 * screen used to lift a pinned row that started asking into Needs You, which
 * made the one deliberately-placed row jump bands exactly when the operator
 * was about to look for it.
 *
 * A PINNED ASK APPEARS IN BOTH BANDS. Round 2's deliberate exception to "one
 * row per mission": Needs You is the complete answer to "where am I needed",
 * and a pinned ask missing from it made the count and the band disagree. So a
 * waiting pinned row keeps its place in Pinned AND renders again in Needs You;
 * the second copy carries a distinct {@link workRowListKey} so the flattened
 * SectionList never sees two children under one key, and both copies get the
 * full attention treatment because the tint, count and Answer/Review action all
 * key off `rowWaitingCount`, not the band.
 *
 * NEEDS YOU still lifts every OTHER asking row out of its project band: on a
 * phone the whole point of the tab is "where am I needed", and a screen of
 * project bands buries that answer below the fold.
 */

/** A worklist row as this screen's SectionList renders it. `listKey` is set
 *  only on the SECOND rendering of a row that appears in two bands (a pinned
 *  ask duplicated into Needs You); the first keeps its canonical identity. */
export type WorkListRow = UnifiedWorkRow & { listKey?: string }

/** The row's canonical identity — issue id or worktree path. Shared by the
 *  loader/press plumbing so both copies of a duplicated row light up together. */
export function workRowId(row: UnifiedWorkRow): string {
  return row.kind === 'issue' ? row.issue.id : row.worktree.path
}

/** The SectionList key: unique across the WHOLE list even when one issue
 *  renders in two bands, because the list flattens its sections. */
export function workRowListKey(row: WorkListRow): string {
  return row.listKey ?? workRowId(row)
}

export interface WorkSection {
  /** Stable band id — also the fold-key suffix (see {@link workGroupFoldKey}). */
  key: string
  label: string
  kind: 'pinned' | 'attention' | 'project'
  /** Rows the band WOULD show — the header's count, independent of the fold. */
  total: number
  data: WorkListRow[]
  snoozedRows: UnifiedIssueRow[]
  closedRows: UnifiedIssueRow[]
}

export interface WorkSectionSplit {
  /** The bands the list renders, in band order, empty bands dropped. */
  sections: WorkSection[]
  /**
   * Reorder scope per band: pinned and every project group with their FULL row
   * sets — including asks the visible list lifted out — because fractional
   * `sortKey` patches only mean anything in the row's original scope
   * [POD-168]. Needs You is a projection, not a scope, so it has no entry.
   */
  orderingSections: WorkSection[]
  issueCount: number
  pinnedCount: number
  /** Every row waiting on the human, WHEREVER it is banded — the subtitle's
   *  "N NEED YOU" must not shrink just because an ask is pinned. */
  attentionCount: number
}

function section(input: Omit<WorkSection, 'total'>): WorkSection {
  return { ...input, total: input.data.length }
}

/** Split the published worklist into the phone's bands. Pure — one derivation
 *  per snapshot, so the header counts and the list can never disagree. */
export function buildWorkSections(
  pinned: readonly UnifiedWorkRow[],
  groups: readonly UnifiedWorkGroup[],
): WorkSectionSplit {
  const sections: WorkSection[] = []
  const ordering: WorkSection[] = []
  if (pinned.length > 0) {
    const band = section({
      key: 'pinned',
      label: 'Pinned',
      kind: 'pinned',
      data: [...pinned],
      snoozedRows: [],
      closedRows: [],
    })
    sections.push(band)
    ordering.push(band)
  }
  // Pinned asks lead the band — they are the rows the operator deliberately
  // placed — as SECOND renderings under a band-scoped list key (see the module
  // note). The group asks keep their canonical identity and source order.
  const pinnedAsks: WorkListRow[] = pinned
    .filter((row) => rowWaitingCount(row) > 0)
    .map((row) => ({ ...row, listKey: `needs-you:${workRowId(row)}` }))
  const attentionRows: WorkListRow[] = [
    ...pinnedAsks,
    ...groups.flatMap((group) => group.rows).filter((row) => rowWaitingCount(row) > 0),
  ]
  if (attentionRows.length > 0) {
    sections.push(
      section({
        key: 'needs-you',
        label: 'Needs you',
        kind: 'attention',
        data: attentionRows,
        snoozedRows: [],
        closedRows: [],
      }),
    )
  }
  for (const group of groups) {
    if (group.rows.length + group.snoozedRows.length + group.closedRows.length === 0) continue
    const live = group.rows.filter((row) => rowWaitingCount(row) === 0)
    const band = section({
      key: group.key,
      label: group.label,
      kind: 'project',
      data: live,
      snoozedRows: group.snoozedRows,
      closedRows: group.closedRows,
    })
    ordering.push({ ...band, data: [...group.rows], total: group.rows.length })
    if (live.length + group.snoozedRows.length + group.closedRows.length > 0) {
      sections.push(band)
    }
  }
  const open = [...pinned, ...groups.flatMap((group) => group.rows)]
  return {
    sections,
    orderingSections: ordering,
    issueCount: open.filter((row) => row.kind === 'issue').length,
    pinnedCount: pinned.length,
    attentionCount: open.filter((row) => rowWaitingCount(row) > 0).length,
  }
}

/**
 * Fold state for one Work band, spelled into the ALREADY-CLASSIFIED
 * `podium:sidebar:` namespace — see `./fold-keys.ts` for why: the ui-state
 * classifier is default-closed and THROWS on an unregistered key, and this
 * spelling routes to the per-user replicated `sidebar.section.*` family, so a
 * band folded on the couch is folded at the desk too. The suffix is the
 * section key (`pinned`, `needs-you`, or the group's repo key), the same
 * suffix the Snoozed/Closed fold keys already use.
 */
export const workGroupFoldKey = (sectionKey: string): string =>
  `podium:sidebar:work-group-fold:${sectionKey}`

/**
 * Apply the operator's folds: a collapsed band keeps its header (and therefore
 * its count) and drops its rows AND its Snoozed/Closed disclosures —
 * compression, not concealment. An active search overrides every fold: "no
 * matching work" because the match sat in a folded band is a lie the operator
 * cannot diagnose.
 */
export function foldWorkSections(
  sections: readonly WorkSection[],
  collapsedKeys: ReadonlySet<string>,
  searching: boolean,
): WorkSection[] {
  if (searching) return [...sections]
  return sections.map((band) =>
    collapsedKeys.has(band.key) ? { ...band, data: [], snoozedRows: [], closedRows: [] } : band,
  )
}
