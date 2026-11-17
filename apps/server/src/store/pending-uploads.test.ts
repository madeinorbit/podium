import { asArtifactId, asIssueId, asUserId } from '@podium/model'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { SessionStore } from '../store'
import { openTestStore } from '../test-support/open-test-store'
import { openWorkspaceStores } from '../test-support/workspace-stores'
import type { PendingUploadRow } from './pending-uploads'

/**
 * THE RECORDS OF COMPOSER UPLOADS (POD-6963 design 2.5, POD-7055).
 *
 * The rules the pending-upload store leans on: a claim is recorded only on an
 * unclaimed row, only the claiming issue clears it, a discard removes only an
 * unclaimed row of its owner, and every statement stays inside its workspace.
 */

let store: SessionStore

beforeEach(async () => {
  store = await openTestStore(':memory:')
})
afterEach(async () => {
  await store.close()
})

const ALICE = asUserId('user:alice')
const ISSUE = asIssueId('iss_1')
const OTHER = asIssueId('iss_2')
const row = (id: string, createdAt = 1_000): PendingUploadRow => ({
  id,
  ownerUserId: ALICE,
  filename: 'Screen Shot.png',
  entry: 'Screen Shot.png',
  mediaType: 'image/png',
  size: 3,
  createdAt,
})

describe('pending_uploads', () => {
  it('records an upload once; a second insert of the same id changes nothing', async () => {
    const uploads = store.pendingUploads
    expect(await uploads.insert(row('u1'))).toBe(true)
    expect(await uploads.insert({ ...row('u1'), filename: 'other.png' })).toBe(false)
    expect(await uploads.get('u1')).toEqual(row('u1'))
    expect(await uploads.get('missing')).toBeUndefined()
    // A row written with its claim (the boot conversion of a claimed meta.json) reads back whole.
    const claimed = { ...row('u2'), claimed: { issueId: ISSUE, artifactId: asArtifactId('a1') } }
    expect(await uploads.insert(claimed)).toBe(true)
    expect(await uploads.get('u2')).toEqual(claimed)
  })

  it('records a claim only on an unclaimed row, and only that issue clears it', async () => {
    const uploads = store.pendingUploads
    await uploads.insert(row('u1'))
    expect(await uploads.claim('u1', ISSUE, asArtifactId('a1'))).toBe(true)
    // A second claimer that read before the first claim was recorded loses.
    expect(await uploads.claim('u1', OTHER, asArtifactId('a2'))).toBe(false)
    expect((await uploads.get('u1'))?.claimed).toEqual({
      issueId: ISSUE,
      artifactId: asArtifactId('a1'),
    })
    expect((await uploads.claimedBy(ISSUE)).map((r) => r.id)).toEqual(['u1'])
    await uploads.unclaim('u1', OTHER)
    expect((await uploads.get('u1'))?.claimed?.issueId).toBe(ISSUE)
    await uploads.unclaim('u1', ISSUE)
    expect(await uploads.get('u1')).toEqual(row('u1'))
    expect(await uploads.claimedBy(ISSUE)).toEqual([])
    // An upload that is gone takes no claim.
    expect(await uploads.claim('missing', ISSUE, asArtifactId('a1'))).toBe(false)
  })

  it('deletes an unclaimed row of its owner only; delete removes any row', async () => {
    const uploads = store.pendingUploads
    await uploads.insert(row('u1'))
    await uploads.insert(row('u2'))
    await uploads.claim('u2', ISSUE, asArtifactId('a1'))
    expect(await uploads.deleteUnclaimed('u1', asUserId('user:bob'))).toBe(false)
    expect(await uploads.deleteUnclaimed('u2', ALICE)).toBe(false)
    expect(await uploads.deleteUnclaimed('u1', ALICE)).toBe(true)
    expect(await uploads.get('u1')).toBeUndefined()
    await uploads.delete('u2')
    await uploads.delete('u2')
    expect(await uploads.get('u2')).toBeUndefined()
  })

  it('lists uploads made before a time, oldest first, in bounded pages', async () => {
    const uploads = store.pendingUploads
    await uploads.insert(row('late', 3_000))
    await uploads.insert(row('old', 1_000))
    await uploads.insert(row('older', 500))
    expect(await uploads.createdBefore(2_000, 10)).toEqual([
      { id: 'older', entry: 'Screen Shot.png' },
      { id: 'old', entry: 'Screen Shot.png' },
    ])
    expect(await uploads.createdBefore(2_000, 1)).toEqual([
      { id: 'older', entry: 'Screen Shot.png' },
    ])
  })

  it("keeps each workspace's uploads apart under the same ids", async () => {
    const [a, b] = await openWorkspaceStores(['ws_a', 'ws_b'])
    try {
      await a.pendingUploads.insert(row('u1'))
      expect(await b.pendingUploads.get('u1')).toBeUndefined()
      expect(await b.pendingUploads.claim('u1', ISSUE, asArtifactId('a1'))).toBe(false)
      expect(await b.pendingUploads.insert(row('u1'))).toBe(true)
      expect(await b.pendingUploads.claim('u1', ISSUE, asArtifactId('a1'))).toBe(true)
      expect(await a.pendingUploads.get('u1')).toEqual(row('u1'))
      expect(await a.pendingUploads.claimedBy(ISSUE)).toEqual([])
      expect(await b.pendingUploads.deleteUnclaimed('u1', ALICE)).toBe(false)
      await b.pendingUploads.delete('u1')
      expect(await a.pendingUploads.get('u1')).toBeDefined()
      expect(await b.pendingUploads.createdBefore(Number.MAX_SAFE_INTEGER, 10)).toEqual([])
    } finally {
      await a.close()
    }
  })
})
