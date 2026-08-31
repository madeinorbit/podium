import {
  asArtifactId,
  asIssueId,
  type IssuePanelArtifact,
  type IssueWire,
  type SessionOffer,
} from '@podium/model'
import { describe, expect, it } from 'vitest'
import { offerArtifactRows, resolveOfferArtifacts } from './offer-artifacts'

// Offer evidence on the phone [POD-120]: the desktop's resolution, plus the
// per-row draw/open facts the strip needs — kept pure so the mapping is
// testable without a renderer, a store, or a server profile.

const ORIGIN = 'https://podium.local'

function issue(artifacts: IssuePanelArtifact[]): IssueWire {
  return {
    id: asIssueId('iss_offer'),
    seq: 1,
    title: 'Task',
    repoPath: '/repo',
    worktreePath: '/repo/.worktrees/POD-1',
    panel: { todos: [], artifacts, deferred: [] },
  } as unknown as IssueWire
}

const art = (
  path: string,
  addedAt: string,
  extra: Partial<IssuePanelArtifact> = {},
): IssuePanelArtifact => ({ path, addedAt, ...extra })

const offerFor = (artifacts?: string[]): SessionOffer => ({
  message: 'Ready to merge',
  actions: [],
  ...(artifacts ? { artifacts } : {}),
  createdAt: '2026-08-27T12:00:00.000Z',
})

describe('resolveOfferArtifacts', () => {
  it('keeps offer order, takes the newest re-add, drops what no longer resolves', () => {
    const old = art('shot.png', '2026-08-01T00:00:00.000Z')
    const fresh = art('shot.png', '2026-08-20T00:00:00.000Z')
    const notes = art('docs/notes.md', '2026-08-02T00:00:00.000Z')
    const resolved = resolveOfferArtifacts({
      offer: offerFor(['docs/notes.md', 'shot.png', 'gone.png', 'shot.png']),
      issue: issue([old, notes, fresh]),
    })
    // Offer order, the newest entry per path, and a repeat shows once.
    expect(resolved).toEqual([notes, fresh])
  })

  it('falls back to artifacts published since the human last typed', () => {
    const before = art('a.png', '2026-08-27T11:00:00.000Z')
    const after1 = art('b.png', '2026-08-27T12:30:00.000Z')
    const after2 = art('c.png', '2026-08-27T12:40:00.000Z')
    const args = { offer: offerFor(), issue: issue([before, after1, after2]) }
    expect(resolveOfferArtifacts({ ...args, lastInputAt: '2026-08-27T12:00:00.000Z' })).toEqual([
      after2,
      after1,
    ])
    // No anchor, no baseline for "new" — the strip stays empty rather than
    // guessing which of the issue's artifacts this offer meant.
    expect(resolveOfferArtifacts(args)).toEqual([])
  })
})

describe('offerArtifactRows', () => {
  it('draws each resolved artifact with its label, preview class, kind tag and URL', () => {
    const { rows, extra } = offerArtifactRows({
      offer: offerFor(['shot.png', 'notes.md', 'deck.html']),
      issue: issue([
        art('shot.png', '2026-08-20T00:00:00.000Z', { artifactId: asArtifactId('art_1') }),
        art('notes.md', '2026-08-20T00:00:01.000Z', { title: 'The plan' }),
        art('deck.html', '2026-08-20T00:00:02.000Z'),
      ]),
      httpOrigin: ORIGIN,
    })

    expect(extra).toBe(0)
    expect(rows.map((r) => [r.label, r.preview, r.kind])).toEqual([
      ['shot.png', 'image', 'PNG'],
      // A titled artifact is named by its title, exactly as the task page names it.
      ['The plan', 'markdown', 'MD'],
      ['deck.html', 'html', 'HTML'],
    ])
    // Keyed by path AND stamp so a re-added artifact is a new row, not a reused one.
    expect(rows[0]?.key).toBe('shot.png@2026-08-20T00:00:00.000Z')
    // The snapshot route for a stored artifact; every row carries an openable URL.
    expect(rows[0]?.url).toContain('/files/artifact/')
    expect(rows.every((r) => r.url !== null)).toBe(true)
  })

  it('caps the strip and reports the remainder for the "+N" chip', () => {
    const paths = ['a.png', 'b.png', 'c.png', 'd.png', 'e.png']
    const { rows, extra } = offerArtifactRows({
      offer: offerFor(paths),
      issue: issue(paths.map((p) => art(p, '2026-08-20T00:00:00.000Z'))),
      httpOrigin: ORIGIN,
    })
    expect(rows.map((r) => r.label)).toEqual(['a.png', 'b.png', 'c.png'])
    expect(extra).toBe(2)
  })

  it('names an extensionless file by its preview class rather than a bare chip', () => {
    const { rows } = offerArtifactRows({
      offer: offerFor(['LICENSE']),
      issue: issue([art('LICENSE', '2026-08-20T00:00:00.000Z')]),
      httpOrigin: ORIGIN,
    })
    expect(rows[0]?.kind).toBe('FILE')
  })

  it('has no rows — and so no strip — when nothing resolves or there is no issue', () => {
    expect(
      offerArtifactRows({
        offer: offerFor(['gone.png']),
        issue: issue([art('real.png', '2026-08-20T00:00:00.000Z')]),
        httpOrigin: ORIGIN,
      }),
    ).toEqual({ rows: [], extra: 0 })
    expect(
      offerArtifactRows({ offer: offerFor(['shot.png']), issue: undefined, httpOrigin: ORIGIN }),
    ).toEqual({ rows: [], extra: 0 })
  })
})
