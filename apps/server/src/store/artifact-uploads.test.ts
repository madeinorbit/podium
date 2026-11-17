import { asIssueId } from '@podium/model'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { SessionStore } from '../store'
import { openTestStore } from '../test-support/open-test-store'
import { openWorkspaceStores } from '../test-support/workspace-stores'

/**
 * THE STATE OF CLI BUNDLE UPLOADS (POD-6963 design 2.4, POD-7054).
 *
 * The rules the artifact store leans on: a begin never resets an upload, a
 * packet is accepted only where the row still holds what the sender read, and
 * every statement stays inside its workspace.
 */

let store: SessionStore

beforeEach(async () => {
  store = await openTestStore(':memory:')
})
afterEach(async () => {
  await store.close()
})

const ISSUE = asIssueId('iss_upload')
const row = (uploadId: string, createdAt = 1_000) => ({
  issueId: ISSUE,
  uploadId,
  beginJson: '{"action":"begin"}',
  received: [0, 0],
  createdAt,
})

describe('artifact_uploads', () => {
  it('records an upload once; a second begin of the same id changes nothing', async () => {
    const uploads = store.artifactUploads
    expect(await uploads.begin(row('u1'))).toBe(true)
    expect(await uploads.advance(ISSUE, 'u1', [0, 0], [5, 0])).toBe(true)
    expect(await uploads.begin({ ...row('u1'), beginJson: '{"other":true}' })).toBe(false)
    expect(await uploads.get(ISSUE, 'u1')).toEqual({ ...row('u1'), received: [5, 0] })
  })

  it('advances received bytes only from the counts the caller read', async () => {
    const uploads = store.artifactUploads
    await uploads.begin(row('u1'))
    expect(await uploads.advance(ISSUE, 'u1', [0, 0], [3, 0])).toBe(true)
    // A second sender that read before the first packet was accepted loses.
    expect(await uploads.advance(ISSUE, 'u1', [0, 0], [0, 4])).toBe(false)
    expect(await uploads.advance(ISSUE, 'u1', [3, 0], [3, 4])).toBe(true)
    expect((await uploads.get(ISSUE, 'u1'))?.received).toEqual([3, 4])
    // An upload that is gone accepts nothing.
    expect(await uploads.advance(ISSUE, 'missing', [0, 0], [1, 0])).toBe(false)
  })

  it('deletes one upload or every upload of an issue', async () => {
    const uploads = store.artifactUploads
    await uploads.begin(row('u1'))
    await uploads.begin(row('u2'))
    await uploads.begin({ ...row('u3'), issueId: asIssueId('iss_other') })
    await uploads.delete(ISSUE, 'u1')
    expect(await uploads.get(ISSUE, 'u1')).toBeUndefined()
    await uploads.deleteIssue(ISSUE)
    expect(await uploads.get(ISSUE, 'u2')).toBeUndefined()
    expect(await uploads.get(asIssueId('iss_other'), 'u3')).toBeDefined()
  })

  it('lists uploads begun before a time, oldest first, in bounded pages', async () => {
    const uploads = store.artifactUploads
    await uploads.begin(row('late', 3_000))
    await uploads.begin(row('old', 1_000))
    await uploads.begin(row('older', 500))
    expect(await uploads.createdBefore(2_000, 10)).toEqual([
      { issueId: ISSUE, uploadId: 'older' },
      { issueId: ISSUE, uploadId: 'old' },
    ])
    expect(await uploads.createdBefore(2_000, 1)).toEqual([{ issueId: ISSUE, uploadId: 'older' }])
  })

  it("keeps each workspace's uploads apart under the same ids", async () => {
    const [a, b] = await openWorkspaceStores(['ws_a', 'ws_b'])
    try {
      await a.artifactUploads.begin(row('u1'))
      expect(await b.artifactUploads.get(ISSUE, 'u1')).toBeUndefined()
      expect(await b.artifactUploads.begin(row('u1'))).toBe(true)
      expect(await b.artifactUploads.advance(ISSUE, 'u1', [0, 0], [9, 9])).toBe(true)
      expect((await a.artifactUploads.get(ISSUE, 'u1'))?.received).toEqual([0, 0])
      await b.artifactUploads.deleteIssue(ISSUE)
      expect(await a.artifactUploads.get(ISSUE, 'u1')).toBeDefined()
      expect(await b.artifactUploads.createdBefore(Number.MAX_SAFE_INTEGER, 10)).toEqual([])
    } finally {
      await a.close()
    }
  })
})
