import { readStoredFileTabs } from '@podium/client-core/ui-state'
import { tabIdFor } from '@podium/client-core/values'
import { asIssueId } from '@podium/model/browser'
import { describe, expect, it, vi } from 'vitest'

vi.mock('@/app/command-launch-data', () => ({ useCommandLaunchActions: () => ({}) }))
vi.mock('@/app/store-worklist-pool', () => ({ useWorklistPoolProjection: () => undefined }))
vi.mock('@/features/issues/issue-page/opening-context', () => ({ useIssueViews: () => null }))

const {
  ARTIFACTS_TAB_ARTIFACT_ID,
  ARTIFACTS_TAB_PATH,
  artifactCategory,
  artifactTypeLabel,
  indexArtifacts,
  isArtifactsTab,
  openArtifactsTab,
  shortDate,
} = await import('./artifacts-tab')

const art = (path: string, over: { title?: string; addedAt?: string; entry?: string } = {}) => ({
  path,
  addedAt: over.addedAt ?? '2026-10-11T10:00:00.000Z',
  ...over,
})

describe('artifact categories', () => {
  it('groups pictures as screens, verdicts as reports, the rest as documents', () => {
    expect(artifactCategory(art('shots/consent.png'))).toBe('screen')
    expect(artifactCategory(art('demo.webm'))).toBe('screen')
    expect(artifactCategory(art('host-validation.html'))).toBe('report')
    expect(artifactCategory(art('notes.md', { title: 'Opus final auth review' }))).toBe('report')
    expect(artifactCategory(art('submit-offer.md'))).toBe('document')
    expect(artifactCategory(art('pipp-v0.2.0.zip'))).toBe('document')
  })

  it('reads the snapshot entry before the path', () => {
    expect(artifactCategory(art('bundle', { entry: 'index.png' }))).toBe('screen')
  })

  it('labels the type column finer than the filter', () => {
    expect(artifactTypeLabel(art('pipp-v0.2.0.zip'))).toBe('Package')
    expect(artifactTypeLabel(art('rows.csv'))).toBe('Data')
    expect(artifactTypeLabel(art('notes.md'))).toBe('Document')
    expect(artifactTypeLabel(art('audit.pdf'))).toBe('Report')
    expect(artifactTypeLabel(art('a.mp4'))).toBe('Video')
  })
})

describe('indexArtifacts', () => {
  const list = [
    art('a.png', { addedAt: '2026-10-09T00:00:00Z' }),
    art('b.png', { addedAt: '2026-10-11T00:00:00Z' }),
    art('report.html', { title: 'Host validation' }),
    art('offer.md'),
  ]

  it('counts every group over the whole list and orders newest first', () => {
    const index = indexArtifacts(list, 'all', '')
    expect(index.counts).toEqual({ all: 4, screen: 2, document: 1, report: 1 })
    expect(index.totals).toEqual(index.counts)
    expect(index.screens.map((a) => a.path)).toEqual(['b.png', 'a.png'])
    expect(index.documents).toHaveLength(2)
  })

  it('filters by chip, and counts what the search matches', () => {
    const reports = indexArtifacts(list, 'report', '')
    expect(reports.screens).toEqual([])
    expect(reports.documents.map((a) => a.path)).toEqual(['report.html'])
    const searched = indexArtifacts(list, 'all', 'VALIDATION')
    expect(searched.documents.map((a) => a.path)).toEqual(['report.html'])
    expect(searched.counts).toEqual({ all: 1, screen: 0, document: 0, report: 1 })
    expect(searched.totals.all).toBe(4)
    // A zero-hit search reads as zeros, not the untouched totals.
    expect(indexArtifacts(list, 'screen', 'nothing-matches').counts.all).toBe(0)
  })
})

describe('the Artifacts tab record', () => {
  const issueId = asIssueId('iss_1')

  it('opens through openArtifact with the sentinel id', () => {
    const openArtifact = vi.fn()
    openArtifactsTab(openArtifact, { issueId, worktreePath: '/repo/wt' })
    expect(openArtifact).toHaveBeenCalledWith({
      issueId,
      artifactId: ARTIFACTS_TAB_ARTIFACT_ID,
      path: ARTIFACTS_TAB_PATH,
      worktreePath: '/repo/wt',
    })
  })

  it('survives a reload like any file tab', () => {
    const scope = { kind: 'artifact' as const, issueId, artifactId: ARTIFACTS_TAB_ARTIFACT_ID }
    const stored = [
      {
        id: tabIdFor(scope, ARTIFACTS_TAB_PATH),
        scope,
        path: ARTIFACTS_TAB_PATH,
        worktreePath: '',
        issueId,
      },
    ]
    const [restored] = readStoredFileTabs({ get: () => JSON.stringify(stored) })
    expect(restored && isArtifactsTab(restored)).toBe(true)
    expect(restored?.issueId).toBe(issueId)
  })

  it('is not mistaken for a real artifact', () => {
    const scope = { kind: 'artifact' as const, issueId, artifactId: 'art_123' as never }
    expect(isArtifactsTab({ scope })).toBe(false)
  })
})

describe('shortDate', () => {
  it('prints MM-DD and nothing for a bad date', () => {
    expect(shortDate('2026-10-11T12:00:00')).toBe('10-11')
    expect(shortDate('nope')).toBe('')
  })
})
