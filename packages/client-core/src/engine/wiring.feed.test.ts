/**
 * The live persist seam (`onMetadataApplied`) against the healing ladder.
 *
 * `feed.test.ts` proves the ladder's decisions and `bootstrap.test.ts` proves
 * the outbox survives a discard. Neither proves the two are actually WIRED
 * together on the path the app runs — which is the failure that would ship: a
 * correct ladder nobody calls, an epoch bump silently welded onto the old
 * timeline, and every unit test green.
 */

import { describe, expect, it, vi } from 'vitest'
import type { OutboxEntry } from '../outbox'
import { COLD_CURSOR } from '../replica/feed'
import { createReplica, memoryStorage } from '../replica/replica'
import type { MetadataAppliedState } from '../transport'
import { createEngineHub } from './wiring'

/** Build the hub wiring over a real replica, capturing the persist hook. */
function setup() {
  const replica = createReplica({ storage: memoryStorage() })
  let onMetadataApplied: ((state: MetadataAppliedState) => void) | undefined
  createEngineHub({
    wsClientUrl: 'ws://x',
    // biome-ignore lint/suspicious/noExplicitAny: the wiring only reads sync.changesSince here
    api: { sync: { changesSince: { query: vi.fn() } } } as any,
    replica,
    onFatalError: () => {},
    createHub: (opts) => {
      onMetadataApplied = opts.onMetadataApplied
      // biome-ignore lint/suspicious/noExplicitAny: the returned hub is never used by these tests
      return {} as any
    },
  })
  return {
    replica,
    apply: (state: MetadataAppliedState) => onMetadataApplied?.(state),
  }
}

/** The entity lists half of a MetadataAppliedState. Only `issues` varies here —
 *  the identity rules under test are kind-agnostic. */
const lists = (
  issues: Array<{ id: string; title: string }>,
): Omit<MetadataAppliedState, 'cursor'> => ({
  sessions: [],
  issues: issues as unknown as MetadataAppliedState['issues'],
  issueProjections: [],
  issueDeps: [],
  repos: [],
  conversations: [],
  automations: [],
  automationRuns: [],
})

const userWrite: OutboxEntry = {
  mutationId: 'mut_1',
  kind: 'issue.create',
  input: { title: 'user work' },
  queuedAt: 1,
}

describe('onMetadataApplied — the cursor is the triple (ADR 2 D1)', () => {
  it('persists the stamped identity, not just the seq', () => {
    const { replica, apply } = setup()
    apply({ cursor: 5, ...lists([{ id: 'i1', title: 'one' }]), feedId: 'feed_1', epoch: 'epoch_1' })
    expect(replica.getFeedCursor()).toEqual({ feedId: 'feed_1', epoch: 'epoch_1', seq: 5 })
  })

  it('an authority that stamps nothing still syncs — the seq advances alone', () => {
    const { replica, apply } = setup()
    apply({ cursor: 5, ...lists([{ id: 'i1', title: 'one' }]) })
    expect(replica.getFeedCursor()).toEqual({ ...COLD_CURSOR, seq: 5 })
    expect(replica.rows('issues')).toHaveLength(1)
  })

  it('an UNSTAMPED batch does not blank an identity already established', () => {
    const { replica, apply } = setup()
    apply({ cursor: 5, ...lists([]), feedId: 'feed_1', epoch: 'epoch_1' })
    apply({ cursor: 6, ...lists([]) })
    expect(replica.getFeedCursor()).toEqual({ feedId: 'feed_1', epoch: 'epoch_1', seq: 6 })
  })
})

describe('onMetadataApplied — rung 4 is wired, not just implemented', () => {
  it('an epoch bump discards the cache and installs the new timeline', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const { replica, apply } = setup()
      apply({
        cursor: 77,
        ...lists([{ id: 'phantom', title: 'from the dead timeline' }]),
        feedId: 'feed_1',
        epoch: 'epoch_1',
      })
      replica.outboxStorage().save([userWrite])
      expect(replica.rows('issues').map((i) => i.id)).toEqual(['phantom'])

      // The authority was restored from a backup: same feed, new epoch.
      apply({
        cursor: 3,
        ...lists([{ id: 'real', title: 'from the live timeline' }]),
        feedId: 'feed_1',
        epoch: 'epoch_2',
      })

      // The phantom is gone — and gone because it was DISCARDED, not because a
      // snapshot happened to overwrite it. A lower cursor (3 < 77) is exactly
      // what a restored authority looks like.
      expect(replica.rows('issues').map((i) => i.id)).toEqual(['real'])
      expect(replica.getFeedCursor()).toEqual({ feedId: 'feed_1', epoch: 'epoch_2', seq: 3 })
      // The user's unsent write is not a cache.
      expect(replica.outboxStorage().load()).toEqual([userWrite])
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('feed identity changed'))
    } finally {
      warn.mockRestore()
    }
  })

  it('the UI is never blank: the replacement lands in the same turn as the discard', () => {
    // D7's "stale-visible, never blank" at this seam. The state being installed
    // is the authority's, taken at the new identity, so the discard and the
    // install are one turn — a subscriber never observes the empty middle.
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const { replica, apply } = setup()
      apply({
        cursor: 77,
        ...lists([{ id: 'old', title: 'old' }]),
        feedId: 'feed_1',
        epoch: 'epoch_1',
      })

      const seen: number[] = []
      replica.subscribeRows('issues', () => seen.push(replica.rows('issues').length))
      apply({
        cursor: 3,
        ...lists([{ id: 'new', title: 'new' }]),
        feedId: 'feed_1',
        epoch: 'epoch_2',
      })

      // Never an observed zero — the resetCache empties, the install refills,
      // and no subscriber wakes in between.
      expect(seen).not.toContain(0)
      expect(replica.rows('issues').map((i) => i.id)).toEqual(['new'])
    } finally {
      warn.mockRestore()
    }
  })

  it('the SAME identity does not discard — a normal batch is a normal batch', () => {
    const { replica, apply } = setup()
    apply({ cursor: 5, ...lists([{ id: 'i1', title: 'one' }]), feedId: 'feed_1', epoch: 'epoch_1' })
    apply({
      cursor: 6,
      ...lists([
        { id: 'i1', title: 'one' },
        { id: 'i2', title: 'two' },
      ]),
      feedId: 'feed_1',
      epoch: 'epoch_1',
    })
    expect(replica.rows('issues').map((i) => i.id)).toEqual(['i1', 'i2'])
    expect(replica.getFeedCursor().seq).toBe(6)
  })
})
