/**
 * THE OFFER HARNESS'S STORE (POD-1462).
 *
 * `OfferBar` itself is prop-driven, but its evidence strip (`OfferArtifactStrip`)
 * reads `app/store` for the http origin and the issue replica — and the strip is
 * half of what the offer's layout has to hold. A harness has no server behind it,
 * so this stands in for that module; the vite config redirects it by RESOLVED
 * PATH so `@/app/store` lands here.
 *
 * The image tiles point at real bytes the harness's vite config serves, because
 * a broken <img> paints a broken-image glyph instead of a preview and would
 * make every screenshot in this harness a lie.
 */
import type { IssueViewModel } from '@podium/client-core/replica'

/** Six, so `?evidence=6` overflows the row into "+N"; the first three are the
 *  common mix (two screenshots and an HTML concept). */
const ARTIFACTS = [
  ['docs/sweep-a.png', 'Row tint sweep — 0.4 / 0.5', 'art_a'],
  ['docs/sweep-b.png', 'Row tint sweep — 0.6 / 0.7', 'art_b'],
  ['docs/concept.html', 'Interaction concept', 'art_c'],
  ['docs/sweep-dark.png', 'Row tint sweep, dark', 'art_d'],
  ['docs/notes.md', 'Dose notes', 'art_e'],
  ['docs/sweep-hover.png', 'Hover states', 'art_f'],
].map(([path, title, artifactId], i) => ({
  path,
  entry: path,
  title,
  addedAt: `2026-08-21T09:0${i}:00.000Z`,
  artifactId,
}))

/** The paths an offer in the harness names: the first `n` artifacts. */
export const offerArtifactPaths = (n: number): string[] => ARTIFACTS.slice(0, n).map((a) => a.path)

export const ISSUE = {
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
} as unknown as IssueViewModel

const STATE = {
  // Same-origin: the harness serves `/harness/thumb-*.svg` itself.
  httpOrigin: '',
  openArtifact: (args: unknown) => console.info('openArtifact', args),
  openFileInWorktree: () => {},
}

export function readFixture<T>(selector: (s: typeof STATE) => T): T {
  return selector(STATE)
}

export function useReplicaIssues(): IssueViewModel[] {
  return [ISSUE]
}
