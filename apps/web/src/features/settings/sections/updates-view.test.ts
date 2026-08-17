import type { Operation } from '@podium/protocol'
import { describe, expect, it } from 'vitest'
import {
  channelStatusRows,
  channelUnavailableProse,
  describeChannelStatus,
  describeCheckOutcome,
  historyRows,
  sourceUnavailableProse,
} from './updates-view'

const NOW = 1_765_700_000_000

describe('channel prose (spec §6.3)', () => {
  /**
   * The literal strings this section used to be able to render. Each one is an
   * internal precondition, and each one has a sentence that replaces it.
   */
  it.each([
    'No update target is configured.',
    'stable target resolver is not configured.',
    'stable target has not been resolved by this coordinator.',
    'Development target is not currently published by this source server.',
  ])('turns %s into prose', (reason) => {
    expect(channelUnavailableProse('stable', reason)).toBe('Nothing published on Stable yet.')
  })

  it('says the same thing when the server said nothing at all', () => {
    expect(channelUnavailableProse('edge', null)).toBe('Nothing published on Edge yet.')
    expect(channelUnavailableProse('edge', '   ')).toBe('Nothing published on Edge yet.')
  })

  it('keeps a reason that tells the operator something they can act on', () => {
    expect(channelUnavailableProse('dev', 'The source checkout has 2 uncommitted changes.')).toBe(
      'Nothing to install from Development yet: The source checkout has 2 uncommitted changes.',
    )
  })

  it('finishes a fragment the server left unfinished', () => {
    expect(channelUnavailableProse('dev', 'building the bundle for dev+bbbbbbb')).toBe(
      'Nothing to install from Development yet: building the bundle for dev+bbbbbbb.',
    )
  })

  it('names a source that is not a channel, for a machine on the fleet default', () => {
    expect(sourceUnavailableProse('its update source', 'no target')).toBe(
      'Nothing published on its update source yet.',
    )
  })
})

describe('describeChannelStatus', () => {
  it('names the version when one is published', () => {
    expect(describeChannelStatus('stable', { status: 'ok' }, '0.4.3')).toEqual({
      status: 'Podium 0.4.3 is published on Stable.',
      tone: 'ok',
    })
  })

  it('does not invent a version it was not given', () => {
    expect(describeChannelStatus('edge', { status: 'ok' }, null)).toEqual({
      status: 'A build is published on Edge.',
      tone: 'ok',
    })
  })

  it('says a never-checked channel has not been checked', () => {
    expect(describeChannelStatus('edge', undefined, null)).toEqual({
      status: 'Edge has not been checked yet.',
      tone: 'warning',
    })
  })

  /**
   * An unavailable outcome wins over a stale version: the channel just said it
   * has nothing, and showing the last version it had would be the offer §6.3
   * says must not exist.
   */
  it('prefers the fresh refusal over a version left over from before', () => {
    expect(
      describeChannelStatus('dev', { status: 'unavailable', reason: 'no target' }, '0.4.2'),
    ).toEqual({ status: 'Nothing published on Development yet.', tone: 'warning' })
  })
})

describe('channelStatusRows', () => {
  it('says when each channel was last checked, and when it never was', () => {
    const rows = channelStatusRows({
      channels: ['stable', 'edge'],
      checks: [{ channel: 'stable', checkedAt: NOW - 7_200_000, outcome: { status: 'ok' } }],
      targetByChannel: { stable: '0.4.3' },
      now: NOW,
    })
    expect(rows.map((row) => row.checked)).toEqual(['checked 2h ago', 'never checked'])
    expect(rows[0]?.status).toBe('Podium 0.4.3 is published on Stable.')
    expect(rows[1]?.tone).toBe('warning')
  })
})

describe('describeCheckOutcome (spec §9.2)', () => {
  it('says a fresh check is fresh', () => {
    expect(
      describeCheckOutcome([{ channel: 'stable', checkedAt: NOW, outcome: { status: 'ok' } }], NOW),
    ).toBe('Checked just now.')
  })

  it('says a rate-limited answer is the old answer, still standing', () => {
    expect(
      describeCheckOutcome(
        [{ channel: 'stable', checkedAt: NOW - 1_500_000, outcome: { status: 'ok' } }],
        NOW,
      ),
    ).toBe('Already checked 25m ago — that answer still stands.')
  })

  it('judges the whole set by its oldest record', () => {
    expect(
      describeCheckOutcome(
        [
          { channel: 'stable', checkedAt: NOW, outcome: { status: 'ok' } },
          { channel: 'edge', checkedAt: NOW - 20_000, outcome: { status: 'ok' } },
        ],
        NOW,
      ),
    ).toBe('Already checked just now — that answer still stands.')
  })

  it('has an answer for a server with nothing to check', () => {
    expect(describeCheckOutcome([], NOW)).toBe('This server has no update channel to check.')
  })
})

describe('historyRows (spec §3.7)', () => {
  const operation = (over: Partial<Operation>): Operation =>
    ({
      id: 'op_01j',
      kind: 'update',
      state: 'done',
      details: { target: { version: '0.4.3' } },
      startedAt: NOW - 36_000_000,
      finishedAt: NOW - 36_000_000 + 240_000,
      ...over,
    }) as Operation

  it('answers whether last night’s update finished', () => {
    const [row] = historyRows([operation({})], NOW)
    expect(row).toMatchObject({
      version: 'Podium 0.4.3',
      outcome: { label: 'Finished', tone: 'ok' },
      startedRelative: '10h ago',
      duration: '4 min',
    })
  })

  it('carries the operation id into the copyable detail of a failure', () => {
    const [row] = historyRows(
      [
        operation({
          id: 'op_01k',
          state: 'failed',
          error: { code: 'download-failed', message: 'connection reset' },
        }),
      ],
      NOW,
    )
    expect(row?.outcome).toEqual({ label: 'Failed', tone: 'error' })
    // POD-2241 moved this sentence into the one machine-failure copy table, so
    // history and the panel say it the same way.
    expect(row?.error?.message).toBe('Podium could not download this update.')
    expect(row?.error?.detail).toContain('operation: op_01k')
  })

  /**
   * P8: this bundle is swapped during the operation it renders, so a server can
   * report a state that did not exist when it shipped. A word the user can
   * search for beats a wrong word from a closed list.
   */
  it('keeps a state it has never heard of rather than guessing', () => {
    const [row] = historyRows([operation({ state: 'rolling-back' as Operation['state'] })], NOW)
    expect(row?.outcome).toEqual({ label: 'rolling-back', tone: 'neutral' })
  })

  it('is honest about what an operation did not record', () => {
    const [row] = historyRows(
      [
        {
          id: 'op_01m',
          kind: 'update',
          state: 'canceled',
        } as Operation,
      ],
      NOW,
    )
    expect(row).toMatchObject({
      version: 'No version recorded',
      startedRelative: 'time not recorded',
      outcome: { label: 'Canceled', tone: 'neutral' },
    })
    expect(row?.duration).toBeUndefined()
  })

  it('marks a retry as a retry', () => {
    const [row] = historyRows([operation({ retryOf: 'op_01i' })], NOW)
    expect(row?.retryNote).toBe('Retry of an earlier update')
  })
})
