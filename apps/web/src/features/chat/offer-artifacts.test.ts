import type { IssuePanelArtifact, IssueWire, SessionOffer } from '@podium/protocol'
import { describe, expect, it } from 'vitest'
import { resolveOfferArtifacts } from './offer-artifacts'

// Offer→artifact resolution [POD-120]: agent-curated paths resolve against the
// issue panel's artifact list (newest entry wins, unresolved silently dropped);
// an offer naming none falls back to artifacts newer than the user's last input,
// promoting an interactive HTML review target ahead of screenshot frames.

const art = (path: string, addedAt: string, artifactId?: string): IssuePanelArtifact => ({
  path,
  addedAt,
  ...(artifactId ? { artifactId } : {}),
})

const issueWith = (artifacts: IssuePanelArtifact[]): IssueWire =>
  ({ id: 'iss_1', panel: { todos: [], artifacts, deferred: [] } }) as unknown as IssueWire

const offerWith = (artifacts?: string[]): SessionOffer => ({
  message: 'm',
  actions: [],
  ...(artifacts ? { artifacts } : {}),
  createdAt: '2026-07-21T10:00:00.000Z',
})

describe('resolveOfferArtifacts [POD-120]', () => {
  it('resolves curated paths in offer order, dropping unresolved ones', () => {
    const a = art('e2e/before.png', '2026-07-21T09:00:00.000Z')
    const b = art('e2e/after.png', '2026-07-21T09:30:00.000Z')
    const out = resolveOfferArtifacts({
      offer: offerWith(['e2e/after.png', 'missing.png', 'e2e/before.png']),
      issue: issueWith([a, b]),
    })
    expect(out).toEqual([b, a])
  })

  it('the newest re-added entry wins for a repeated path', () => {
    const old = art('e2e/shot.png', '2026-07-21T08:00:00.000Z', 'art_old')
    const fresh = art('e2e/shot.png', '2026-07-21T09:00:00.000Z', 'art_new')
    const out = resolveOfferArtifacts({
      offer: offerWith(['e2e/shot.png']),
      issue: issueWith([old, fresh]),
    })
    expect(out).toEqual([fresh])
  })

  it('tolerates absolute↔worktree-relative mismatch at a / boundary only', () => {
    const abs = art('/wt/e2e/shot.png', '2026-07-21T09:00:00.000Z')
    expect(
      resolveOfferArtifacts({ offer: offerWith(['e2e/shot.png']), issue: issueWith([abs]) }),
    ).toEqual([abs])
    // 'shot.png' ends 'e2e-shot.png' only without the boundary — no match.
    const near = art('/wt/e2e-shot.png', '2026-07-21T09:00:00.000Z')
    expect(
      resolveOfferArtifacts({ offer: offerWith(['shot.png']), issue: issueWith([near]) }),
    ).toEqual([])
  })

  it('deduplicates two curated paths resolving to one entry', () => {
    const a = art('/wt/e2e/shot.png', '2026-07-21T09:00:00.000Z')
    const out = resolveOfferArtifacts({
      offer: offerWith(['/wt/e2e/shot.png', 'e2e/shot.png']),
      issue: issueWith([a]),
    })
    expect(out).toEqual([a])
  })

  it('falls back to artifacts newer than the last human input, newest first, capped at 3', () => {
    const stale = art('old.png', '2026-07-21T07:00:00.000Z')
    const fresh = ['a.png', 'b.png', 'c.png', 'd.png'].map((p, i) =>
      art(p, `2026-07-21T09:0${i}:00.000Z`),
    )
    const out = resolveOfferArtifacts({
      offer: offerWith(),
      issue: issueWith([stale, ...fresh]),
      lastInputAt: '2026-07-21T08:00:00.000Z',
    })
    expect(out.map((a) => a.path)).toEqual(['d.png', 'c.png', 'b.png'])
  })

  it('promotes a fresh HTML concept in the uncurated fallback', () => {
    const concept = art('concept/mobile.html', '2026-07-21T09:00:00.000Z')
    const frames = ['a.png', 'b.png', 'c.png', 'd.png'].map((p, i) =>
      art(p, `2026-07-21T09:1${i}:00.000Z`),
    )
    const out = resolveOfferArtifacts({
      offer: offerWith(),
      issue: issueWith([concept, ...frames]),
      lastInputAt: '2026-07-21T08:00:00.000Z',
    })
    expect(out.map((a) => a.path)).toEqual(['concept/mobile.html', 'd.png', 'c.png'])
  })

  it('never injects an HTML concept into an explicitly curated offer', () => {
    const concept = art('concept/mobile.html', '2026-07-21T09:00:00.000Z')
    const frame = art('frame.png', '2026-07-21T09:10:00.000Z')
    const out = resolveOfferArtifacts({
      offer: offerWith(['frame.png']),
      issue: issueWith([concept, frame]),
      lastInputAt: '2026-07-21T08:00:00.000Z',
    })
    expect(out).toEqual([frame])
  })

  it('no fallback without a last-input anchor or without an issue', () => {
    const a = art('a.png', '2026-07-21T09:00:00.000Z')
    expect(resolveOfferArtifacts({ offer: offerWith(), issue: issueWith([a]) })).toEqual([])
    expect(
      resolveOfferArtifacts({
        offer: offerWith(['a.png']),
        issue: undefined,
        lastInputAt: '2026-07-21T08:00:00.000Z',
      }),
    ).toEqual([])
  })
})
