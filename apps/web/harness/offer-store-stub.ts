/**
 * THE OFFER HARNESS'S STORE (POD-1462).
 *
 * `OfferBar` itself is prop-driven, but its evidence strip (`OfferArtifactStrip`)
 * reads `app/store` for the http origin and the issue replica — and the strip is
 * half of what the offer's layout has to hold. A harness has no server behind it,
 * so this stands in for that module; the vite config redirects it by RESOLVED
 * PATH so `@/app/store` lands here.
 *
 * The thumbnails point at real files served by vite from `public/`, because a
 * broken <img> lays out at a different size than a loaded one and would make
 * every measurement in this harness a lie.
 */
import type { IssueWire } from '@podium/model/browser'

const ARTIFACTS = [
  {
    path: 'docs/sweep-a.png',
    entry: 'docs/sweep-a.png',
    title: 'Row tint sweep — 0.4 / 0.5',
    addedAt: '2026-08-21T09:00:00.000Z',
    artifactId: 'art_a',
  },
  {
    path: 'docs/sweep-b.png',
    entry: 'docs/sweep-b.png',
    title: 'Row tint sweep — 0.6 / 0.7',
    addedAt: '2026-08-21T09:01:00.000Z',
    artifactId: 'art_b',
  },
]

const ISSUE = {
  id: 'iss_1462',
  seq: 1462,
  displayRef: 'POD-1462',
  title: 'Offer card spacing and buttons',
  stage: 'review',
  archived: false,
  deletedAt: null,
  parentId: null,
  memberSessionIds: ['sess_1'],
  updatedAt: '2026-08-21T09:02:00.000Z',
  labels: [],
  deps: [],
  worktreePath: '/tmp/wt',
  panel: { artifacts: ARTIFACTS },
} as unknown as IssueWire

const STATE = {
  // Same-origin: the harness serves `/harness/thumb-*.svg` itself.
  httpOrigin: '',
  openArtifact: () => {},
  openFileInWorktree: () => {},
}

export function useStoreSelector<T>(selector: (s: typeof STATE) => T): T {
  return selector(STATE)
}

export function useReplicaIssues(): IssueWire[] {
  return [ISSUE]
}
