/**
 * THE v1 KEY-RENAME ARM — the guard for POD-1530's compat surface.
 *
 * WHAT THIS FILE IS FOR. POD-1530 renamed the issue wire key `blockedBy` to
 * `blockedByNotes`, because the old name read like the dependency list and holds
 * something else entirely: an assistant's free text, often a branch name. v2
 * peers get the new name. v1 peers were built before it existed and read
 * `blockedBy`, so `legacy-wire-v1-adapter.ts` renames it back on the way out.
 *
 * WHY IT NEEDS A DEDICATED TEST RATHER THAN A LINE IN THE EDGE SUITE. The
 * failure this guards is SILENT AND SERVER-SIDE-INVISIBLE. Drop the arm and a v1
 * client receives an issue object with no `blockedBy` key. Nothing throws at the
 * gateway, no schema rejects it, no golden fixture moves, and the client renders
 * an absent field — the "Agent notes" block in `IssueRelations.tsx` goes blank,
 * or throws on `.length` of undefined in builds that index it directly. There is
 * no signal on the serving side at all. A compat arm whose removal reddens
 * nothing is indistinguishable from one that was never needed, so the arm is
 * only real if something here says NO when it goes.
 *
 * THE MUTANT THIS IS WRITTEN AGAINST is the whole-arm deletion: make
 * `toV1Value` the identity function (or drop either of its two call sites) and
 * the cases below fail by name. Both call sites are covered deliberately — a v1
 * peer receives issues by TWO routes, `metadataDelta` rows and full
 * `issuesChanged` lists, and an arm on only one produces notes that appear on a
 * delta and vanish on the next reconnect. That reads as intermittent, which is
 * strictly harder to diagnose than either route being broken outright.
 *
 * The v2 cases are the other half of the claim: the arm must be a TRANSLATION
 * FOR OLD PEERS, not a second spelling on the live wire. If v2 ever starts
 * seeing `blockedBy` again, the rename did not happen — it just moved.
 */

import type { ServerMessage } from '@podium/protocol'
import { WIRE_VERSION } from '@podium/protocol'
import { describe, expect, it } from 'vitest'
import { type EdgePeer, type FeedFrame, WireFeedEdge } from './wire-feed-edge'

const FEED = { feedId: 'feed-01J', epoch: 'epoch-01J' } as const

/** The assistant's prose, as `refreshAssistant` actually writes it: a branch
 *  name with a slash and a bare English phrase. NEITHER is an issue id — that is
 *  the fact the rename exists to stop the key from claiming. */
const NOTES = ['issue/9-refactor-the-store', 'the daemon rollout']

/** An issue as it leaves the v2 projection: the NEW key. */
const issueV2 = (id: string) => ({ id, title: id, blockedByNotes: NOTES }) as unknown

const upsert = (seq: number, entity: string, entityId: string, value: unknown) => ({
  seq,
  entity,
  entityId,
  op: 'upsert',
  value,
})

const bootstrap = (changes: unknown[], seq = 1): FeedFrame =>
  ({
    type: 'feedBootstrap',
    ...FEED,
    fromSeq: 0,
    seq,
    minAvailableSeq: 0,
    changes,
    last: true,
  }) as FeedFrame

const delta = (fromSeq: number, seq: number, changes: unknown[]): FeedFrame =>
  ({ type: 'feedDelta', ...FEED, fromSeq, seq, minAvailableSeq: 0, changes }) as FeedFrame

class Peer implements EdgePeer {
  readonly received: ServerMessage[] = []
  constructor(
    readonly id: string,
    readonly wireVersion: number,
    readonly acceptsDelta = false,
  ) {}
  send(message: ServerMessage): void {
    this.received.push(message)
  }
}

const edge = () =>
  new WireFeedEdge({ diagnostics: () => [], visibilityGrade: () => 'device-unscoped' })

/** The issues out of a v1 full-list message. */
const issuesFrom = (peer: Peer): Record<string, unknown>[] =>
  peer.received
    .filter((m): m is ServerMessage & { issues: unknown[] } => m.type === 'issuesChanged')
    .flatMap((m) => m.issues as Record<string, unknown>[])

/** The issue values out of a v1 `metadataDelta`. */
const deltaIssuesFrom = (peer: Peer): Record<string, unknown>[] =>
  peer.received
    .filter(
      (m): m is ServerMessage & { changes: { entity: string; value?: unknown }[] } =>
        m.type === 'metadataDelta',
    )
    .flatMap((m) => m.changes)
    .filter((c) => c.entity === 'issue' && c.value !== undefined)
    .map((c) => c.value as Record<string, unknown>)

describe('v1 peers keep reading blockedBy after the POD-1530 rename', () => {
  it('renames blockedByNotes back to blockedBy in a v1 FULL-LIST snapshot', () => {
    const subject = edge()
    const peer = new Peer('v1-snapshot', 1)
    expect(subject.attach(peer)).toBeNull()

    subject.publish(bootstrap([upsert(1, 'issue', 'i1', issueV2('i1'))]))

    const [issue] = issuesFrom(peer)
    expect(issue, 'a v1 snapshot peer was served no issue at all').toBeDefined()
    // THE ARM. Without it this key is absent and the client's notes block is blank.
    expect(issue?.blockedBy).toEqual(NOTES)
    // And the v2 spelling must not ALSO be there: a v1 client that sees both is
    // being served a shape no v1 client was ever built against.
    expect(issue).not.toHaveProperty('blockedByNotes')
  })

  it('renames blockedByNotes back to blockedBy in a v1 metadataDelta row', () => {
    const subject = edge()
    const peer = new Peer('v1-delta', 1, true)
    expect(subject.attach(peer)).toBeNull()

    // Bootstrap first so the peer has a position, then move the notes.
    subject.publish(bootstrap([upsert(1, 'issue', 'i1', issueV2('i1'))]))
    subject.publish(delta(1, 2, [upsert(2, 'issue', 'i1', issueV2('i1'))]))

    const values = deltaIssuesFrom(peer)
    expect(values.length, 'a v1 delta peer received no issue row').toBeGreaterThan(0)
    for (const value of values) {
      expect(value.blockedBy).toEqual(NOTES)
      expect(value).not.toHaveProperty('blockedByNotes')
    }
  })

  it('leaves a v2 peer on the NEW key — the arm is a translation, not a second spelling', () => {
    const subject = edge()
    const peer = new Peer('v2', WIRE_VERSION)
    expect(subject.attach(peer)).toBeNull()

    const frame = bootstrap([upsert(1, 'issue', 'i1', issueV2('i1'))])
    subject.publish(frame)

    // v2 is the identity path: the frame arrives exactly as published, which is
    // the strongest form of "the rename was not undone for current clients".
    expect(peer.received).toEqual([frame])
  })

  it('does not invent blockedBy on an issue that never had notes', () => {
    // The arm must RENAME a present key, never MANUFACTURE an absent one: an
    // issue with no assistant notes has no `blockedByNotes`, and a v1 client
    // seeing `blockedBy: undefined` where it used to see nothing is a different
    // shape than the one it was built against.
    const subject = edge()
    const peer = new Peer('v1-empty', 1)
    expect(subject.attach(peer)).toBeNull()

    subject.publish(bootstrap([upsert(1, 'issue', 'i1', { id: 'i1', title: 'i1' } as unknown)]))

    const [issue] = issuesFrom(peer)
    expect(issue).toBeDefined()
    expect(issue).not.toHaveProperty('blockedBy')
    expect(issue).not.toHaveProperty('blockedByNotes')
  })
})
