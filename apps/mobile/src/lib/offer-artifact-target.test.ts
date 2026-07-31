import type { IssuePanelArtifact, IssueWire } from '@podium/protocol'
import { describe, expect, it } from 'vitest'
import { offerArtifactTarget } from './offer-artifact-target'

const issue = (overrides: Partial<IssueWire> = {}): IssueWire =>
  ({
    id: 'iss_1',
    repoPath: '/repo',
    worktreePath: '/repo/wt',
    panel: { todos: [], artifacts: [], deferred: [] },
    sessions: [],
    ...overrides,
  }) as unknown as IssueWire

const artifact = (
  path: string,
  overrides: Partial<IssuePanelArtifact> = {},
): IssuePanelArtifact => ({
  path,
  addedAt: '2026-07-31T12:00:00.000Z',
  ...overrides,
})

describe('offerArtifactTarget', () => {
  it('previews a single-file snapshot at its basename when entry is absent', () => {
    expect(
      offerArtifactTarget({
        httpOrigin: 'http://podium.test/',
        issue: issue(),
        artifact: artifact('evidence/mobile shot.png', { artifactId: 'art_1' }),
      }),
    ).toEqual({
      kind: 'image',
      label: 'mobile shot.png',
      uri: 'http://podium.test/files/artifact/iss_1/art_1/mobile%20shot.png',
      previewable: true,
    })
  })

  it('previews a bundled image at its encoded entry path', () => {
    expect(
      offerArtifactTarget({
        httpOrigin: 'http://podium.test',
        issue: issue(),
        artifact: artifact('evidence/report.html', {
          artifactId: 'art_2',
          entry: 'shots/mobile final.png',
          title: 'Mobile final',
        }),
      }),
    ).toMatchObject({
      kind: 'image',
      label: 'Mobile final',
      uri: 'http://podium.test/files/artifact/iss_1/art_2/shots/mobile%20final.png',
      previewable: true,
    })
  })

  it('uses the live worktree URL for a legacy image artifact', () => {
    expect(
      offerArtifactTarget({
        httpOrigin: 'http://podium.test',
        issue: issue({ machineId: 'machine 1' }),
        artifact: artifact('evidence/legacy.png'),
      }),
    ).toMatchObject({
      kind: 'image',
      uri: 'http://podium.test/files/asset?root=%2Frepo%2Fwt&path=evidence%2Flegacy.png&machineId=machine+1',
      previewable: true,
    })
  })

  it('leaves non-image artifacts to their host navigation action', () => {
    expect(
      offerArtifactTarget({
        httpOrigin: 'http://podium.test',
        issue: issue(),
        artifact: artifact('notes/review.md', { artifactId: 'art_3' }),
      }),
    ).toMatchObject({ kind: 'file', previewable: false })
  })
})
