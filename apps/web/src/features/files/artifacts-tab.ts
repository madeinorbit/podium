import type { FileTab } from '@podium/client-core/values'
import { artifactKind, basename } from '@podium/client-core/values'
import type { MobxPool } from '@podium/client-graph'
import type { PageIssue } from '@podium/client-graph/issue-page'
import type { Loaded } from '@podium/client-graph/worklist/rollup'
import type { IssueId, IssuePanelArtifact } from '@podium/model/browser'
import { useCallback } from 'react'
import { useCommandLaunchActions } from '@/app/command-launch-data'
import { useWorklistPoolProjection } from '@/app/store-worklist-pool'
import { useIssueViews } from '@/features/issues/issue-page/opening-context'
import { ARTIFACTS_TAB_ARTIFACT_ID, isArtifactsTabScope } from './artifacts-tab-id'

export { ARTIFACTS_TAB_ARTIFACT_ID, isArtifactsTabScope }

/**
 * THE ARTIFACTS TAB IS A FILE TAB (POD-2078).
 *
 * The stage's Artifacts index rides the artifact file-tab scope with a sentinel
 * artifact id rather than a tab kind of its own. That buys everything a file tab
 * already has for free: it is owned by its issue (so it shows only in that
 * issue's strip), it persists through `readStoredFileTabs` and survives reload,
 * it drags, splits and closes like any tab, and the dock's Issue panel stays on
 * its issue. No real artifact id can collide with it — the store mints
 * opaque ids, never one starting with `@`.
 */
export const ARTIFACTS_TAB_PATH = 'Artifacts'

/** Does this file tab render the Artifacts index rather than a file? */
export function isArtifactsTab(file: Pick<FileTab, 'scope'>): boolean {
  return isArtifactsTabScope(file.scope)
}

type OpenArtifact = ReturnType<typeof useCommandLaunchActions>['openArtifact']

/** Open (or focus) the Artifacts tab for `issueId` in the current pane. */
export function openArtifactsTab(
  openArtifact: OpenArtifact,
  args: { issueId: IssueId; worktreePath?: string | null },
): void {
  openArtifact({
    issueId: args.issueId,
    artifactId: ARTIFACTS_TAB_ARTIFACT_ID,
    path: ARTIFACTS_TAB_PATH,
    ...(args.worktreePath ? { worktreePath: args.worktreePath } : {}),
  })
}

/** The opener for components: the task panel's "View all" and the "+" menu. */
export function useOpenArtifactsTab(): (issueId: IssueId, worktreePath?: string | null) => void {
  const { openArtifact } = useCommandLaunchActions()
  return useCallback(
    (issueId, worktreePath) => openArtifactsTab(openArtifact, { issueId, worktreePath }),
    [openArtifact],
  )
}

/** The issue an Artifacts tab belongs to, read from the same pool page the task
 *  panel reads — no second subscription shape for the same record. Undefined
 *  while loading, null when the issue is gone. */
export function usePageIssue(issueId: string): PageIssue | null | undefined {
  const views = useIssueViews()
  const read = useCallback((_owner: MobxPool) => views?.issue(issueId), [views, issueId])
  const data = useWorklistPoolProjection<Loaded<PageIssue>>(read, undefined)
  return typeof data === 'symbol' ? undefined : data
}

/** The strip's count beside "Artifacts". */
export function useArtifactCount(issueId: string): number {
  return usePageIssue(issueId)?.panel?.artifacts.length ?? 0
}

// ---------------------------------------------------------------------------
// What kind of thing an artifact is
// ---------------------------------------------------------------------------

/** The three filter groups. Screens are pictures; the rest is split by whether
 *  it reads as a finding (a report) or as material (a document). */
export type ArtifactCategory = 'screen' | 'document' | 'report'

const REPORT_EXTS = new Set(['html', 'htm', 'pdf'])
/** Words that make a document a report whatever its format: the verdicts agents
 *  file as evidence. Matched on the title and the file name. */
const REPORT_WORDS = /\b(report|review|audit|validation|findings|verification|results?)\b/i
const PACKAGE_EXTS = new Set(['zip', 'tar', 'gz', 'tgz', 'xz', 'bz2', '7z', 'dmg', 'exe', 'msi'])
const DATA_EXTS = new Set(['json', 'csv', 'tsv', 'ndjson', 'jsonl', 'yaml', 'yml', 'xml'])

function extOf(path: string): string {
  const name = basename(path)
  const dot = name.lastIndexOf('.')
  return dot > 0 ? name.slice(dot + 1).toLowerCase() : ''
}

/** The file the artifact opens to: the snapshot's entry, else its path. */
export function artifactFile(a: Pick<IssuePanelArtifact, 'path' | 'entry'>): string {
  return a.entry ?? a.path
}

export function artifactLabel(a: Pick<IssuePanelArtifact, 'path' | 'title'>): string {
  return a.title ?? basename(a.path)
}

export function artifactCategory(
  a: Pick<IssuePanelArtifact, 'path' | 'entry' | 'title'>,
): ArtifactCategory {
  const file = artifactFile(a)
  if (artifactKind(file) !== 'file') return 'screen'
  if (REPORT_EXTS.has(extOf(file))) return 'report'
  if (REPORT_WORDS.test(a.title ?? '') || REPORT_WORDS.test(basename(file))) return 'report'
  return 'document'
}

/** The type column: one word, finer than the filter group. */
export function artifactTypeLabel(a: Pick<IssuePanelArtifact, 'path' | 'entry' | 'title'>): string {
  const file = artifactFile(a)
  const kind = artifactKind(file)
  if (kind === 'image') return 'Image'
  if (kind === 'video') return 'Video'
  const ext = extOf(file)
  if (artifactCategory(a) === 'report') return 'Report'
  if (PACKAGE_EXTS.has(ext)) return 'Package'
  if (DATA_EXTS.has(ext)) return 'Data'
  return 'Document'
}

/** `MM-DD` like the design; the full date rides the title attribute. */
export function shortDate(iso: string): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return ''
  const mm = String(d.getMonth() + 1).padStart(2, '0')
  const dd = String(d.getDate()).padStart(2, '0')
  return `${mm}-${dd}`
}

export type ArtifactFilter = 'all' | ArtifactCategory

export interface ArtifactIndex<A> {
  /** Count per filter chip: the search's matches per group, so a zero-hit
   *  search reads as zeros rather than the untouched totals. */
  counts: Record<ArtifactFilter, number>
  /** Count per group over the whole list: which chips the issue has at all. */
  totals: Record<ArtifactFilter, number>
  /** Matching artifacts, newest first, split the way the page draws them. */
  screens: A[]
  documents: A[]
}

/**
 * Classify, filter and order once per change of list, filter or query. Pure,
 * so the page's only per-render work is slicing what it shows.
 */
export function indexArtifacts<
  A extends Pick<IssuePanelArtifact, 'path' | 'entry' | 'title' | 'addedAt'>,
>(artifacts: readonly A[], filter: ArtifactFilter, query: string): ArtifactIndex<A> {
  const counts: Record<ArtifactFilter, number> = { all: 0, screen: 0, document: 0, report: 0 }
  const totals: Record<ArtifactFilter, number> = { all: 0, screen: 0, document: 0, report: 0 }
  const needle = query.trim().toLowerCase()
  const screens: A[] = []
  const documents: A[] = []
  const sorted = [...artifacts].sort((x, y) =>
    x.addedAt < y.addedAt ? 1 : x.addedAt > y.addedAt ? -1 : 0,
  )
  for (const a of sorted) {
    const category = artifactCategory(a)
    totals.all += 1
    totals[category] += 1
    if (needle) {
      const hay = `${artifactLabel(a)} ${a.path} ${artifactTypeLabel(a)}`.toLowerCase()
      if (!hay.includes(needle)) continue
    }
    counts.all += 1
    counts[category] += 1
    if (filter !== 'all' && filter !== category) continue
    if (category === 'screen') screens.push(a)
    else documents.push(a)
  }
  return { counts, totals, screens, documents }
}
