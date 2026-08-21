/**
 * SETTINGS → UPDATES AS A PURE FUNCTION OF WHAT THE SERVER SERVES (POD-2103).
 *
 * The panel (`features/updates`) answers "what is happening right now"; this
 * section answers the operator's questions, which are different ones: *did last
 * night's update finish*, *what is my fleet actually offered*, *when did anyone
 * last look*. Spec §3.7 calls the first of those the audit trail that today does
 * not exist, and §9.2 makes the check cadence part of the contract — shown, not
 * implied.
 *
 * Everything here is a pure function so the copy rules can be tested as copy
 * rules. The one rule that needs its own gate is §6.3's last line: **never show
 * an internal precondition as an error**. `No update target is configured.` and
 * `No target: <reason>` were both reachable from this page; the prose functions
 * below are the only path from a server reason to rendered text, so a test that
 * feeds the state which used to produce those strings can prove they are gone.
 */

import { relativeTime } from '@podium/client-core/focus'
import type { Operation, OperationError } from '@podium/protocol'
import {
  type ErrorPresentation,
  formatDuration,
  presentOperationError,
} from '@/features/updates/operation-view'
import { formatDisplayedVersion } from '@/lib/machine-version-skew'

/** Mirrors @podium/model's UpdateChannel; inlined so the bundle never pulls node:fs. */
export type FleetChannel = 'stable' | 'edge' | 'dev'

export const CHANNEL_LABELS: Record<FleetChannel, string> = {
  stable: 'Stable',
  edge: 'Edge',
  dev: 'Development',
}

/** One channel's refresh bookkeeping, as `updates.fleet` serves it (POD-2100). */
export interface ChannelCheck {
  channel: FleetChannel
  checkedAt: number
  outcome: { status: 'ok' } | { status: 'unavailable'; reason: string }
}

export interface ChannelStatusRow {
  channel: FleetChannel
  label: string
  /** Prose. Never a server precondition string (§6.3). */
  status: string
  tone: 'ok' | 'warning'
  /** "checked 2 h ago" — the cadence, said out loud (§9.2). */
  checked: string
  /** The absolute instant, for the title attribute. */
  checkedAtLabel?: string
}

/**
 * Reasons that say nothing more than "there is no target here". They are the
 * internal preconditions §6.3 bans from the surface: a channel with nothing on
 * it is an ordinary state of the world, not a fault to report in the server's
 * own vocabulary. Anything else the server said is a real fact about this
 * deployment (a dirty checkout, a build in flight, a feed that would not answer)
 * and is worth passing on — as a sentence, after a human frame.
 */
const NOTHING_THERE =
  /\bis not configured\b|\bhas not been resolved\b|\bnot currently published\b|\bno update target\b|\bno target\b/i

/** A server fragment, made into something that can end a sentence. */
function asSentence(text: string): string {
  const trimmed = text.trim()
  if (trimmed.length === 0) return ''
  return /[.!?]$/.test(trimmed) ? trimmed : `${trimmed}.`
}

/**
 * Why this channel has nothing to offer, in the user's words.
 *
 * Exported because the per-machine rows need the identical sentence: a machine
 * pinned to `edge` and the Edge channel row are the same fact seen twice, and
 * they used to disagree — the row said `No target: <reason>` while the channel
 * said nothing at all.
 */
export function sourceUnavailableProse(sourceLabel: string, reason: string | null): string {
  const trimmed = (reason ?? '').trim()
  if (trimmed.length === 0 || NOTHING_THERE.test(trimmed)) {
    return `Nothing published on ${sourceLabel} yet.`
  }
  return `Nothing to install from ${sourceLabel} yet: ${asSentence(trimmed)}`
}

/** The same sentence for a named channel — the form Settings → Updates needs. */
export function channelUnavailableProse(channel: FleetChannel, reason: string | null): string {
  return sourceUnavailableProse(CHANNEL_LABELS[channel], reason)
}

export function describeChannelStatus(
  channel: FleetChannel,
  outcome: ChannelCheck['outcome'] | undefined,
  targetVersion: string | null | undefined,
): { status: string; tone: 'ok' | 'warning' } {
  const label = CHANNEL_LABELS[channel]
  if (outcome && outcome.status === 'unavailable') {
    return { status: channelUnavailableProse(channel, outcome.reason), tone: 'warning' }
  }
  if (targetVersion) {
    return {
      status: `Podium ${formatDisplayedVersion(targetVersion)} is published on ${label}.`,
      tone: 'ok',
    }
  }
  // Checked, and it answered — but this server has no machine on the channel to
  // resolve a concrete version through, so saying one would be inventing it.
  if (outcome) return { status: `A build is published on ${label}.`, tone: 'ok' }
  return { status: `${label} has not been checked yet.`, tone: 'warning' }
}

/** "checked 2 h ago" (§9.2). Absent is ordinary: a channel may never have been asked. */
function describeChecked(checkedAt: number | undefined, now: number): string {
  if (checkedAt === undefined) return 'never checked'
  return `checked ${relativeTime(new Date(checkedAt).toISOString(), now)}`
}

/**
 * The channel rows, in the order the user chooses between them.
 *
 * `targetByChannel` is the SERVER's per-machine resolution read back, not a
 * second computation of it: every machine carries the version its own selected
 * authority advertises, so a channel some machine is on already has its answer
 * on the wire. A channel nobody is on has no version, and the copy above says
 * so rather than borrowing another channel's.
 */
export function channelStatusRows(input: {
  channels: readonly FleetChannel[]
  checks: readonly ChannelCheck[]
  targetByChannel: Partial<Record<FleetChannel, string | null>>
  now: number
}): ChannelStatusRow[] {
  return input.channels.map((channel) => {
    const check = input.checks.find((candidate) => candidate.channel === channel)
    const { status, tone } = describeChannelStatus(
      channel,
      check?.outcome,
      input.targetByChannel[channel],
    )
    return {
      channel,
      label: CHANNEL_LABELS[channel],
      status,
      tone,
      checked: describeChecked(check?.checkedAt, input.now),
      ...(check ? { checkedAtLabel: new Date(check.checkedAt).toLocaleString() } : {}),
    }
  })
}

/**
 * What "Check now" actually did, said honestly (§9.2).
 *
 * The service rate-limits a forced check to one feed request per channel per
 * thirty seconds and returns the RECORDED outcome inside that window. A button
 * that answered "checked just now" to that would be the small lie this whole
 * section exists to stop telling: the answer is real, it is just not new.
 */
export function describeCheckOutcome(records: readonly ChannelCheck[], now: number): string {
  if (records.length === 0) return 'This server has no update channel to check.'
  const oldest = records.reduce((a, b) => (a.checkedAt <= b.checkedAt ? a : b))
  // A record the check itself produced is at most a round trip old. Anything
  // older came back out of the rate window unchanged.
  if (now - oldest.checkedAt < 2_000) return 'Checked just now.'
  return `Already checked ${relativeTime(new Date(oldest.checkedAt).toISOString(), now)} — that answer still stands.`
}

export interface HistoryRow {
  id: string
  /** "Podium 0.4.3", or the honest absence when an operation never got a target. */
  version: string
  outcome: { label: string; tone: 'ok' | 'warning' | 'error' | 'neutral' }
  /** "2 h ago" — the relative half of §3.7's "when". */
  startedRelative: string
  /** The absolute instant, for the title attribute — the other half. */
  startedAtLabel?: string
  /** "4 min" — how long it took, when both ends are known. */
  duration?: string
  /** §7's three layers, for a row the user opens. */
  error?: ErrorPresentation
  /** "Retry of an earlier update" (§3.2) — history stays honest about retries. */
  retryNote?: string
}

const OUTCOMES: Record<string, { label: string; tone: HistoryRow['outcome']['tone'] }> = {
  done: { label: 'Finished', tone: 'ok' },
  failed: { label: 'Failed', tone: 'error' },
  canceled: { label: 'Canceled', tone: 'neutral' },
  running: { label: 'In progress', tone: 'warning' },
  waiting: { label: 'In progress', tone: 'warning' },
  pending: { label: 'In progress', tone: 'warning' },
}

function targetVersionOf(operation: Operation): string | undefined {
  const details = operation.details as { target?: { version?: unknown } } | undefined
  const version = details?.target?.version
  return typeof version === 'string' && version.length > 0 ? version : undefined
}

/**
 * §3.7's audit trail, one row per operation.
 *
 * The state vocabulary is an OPEN string (P8): this bundle is swapped during the
 * operation it renders, so a server may report a state it has never heard of.
 * An unknown state keeps its own word rather than being forced into one of ours
 * — the user is better served by a label they can search for than by a wrong one.
 */
export function historyRows(operations: readonly Operation[], now: number): HistoryRow[] {
  return operations.map((operation) => {
    const started = operation.startedAt ?? operation.createdAt
    const finished = operation.finishedAt ?? undefined
    const version = targetVersionOf(operation)
    const outcome = OUTCOMES[operation.state] ?? {
      label: operation.state,
      tone: 'neutral' as const,
    }
    return {
      id: operation.id,
      version: version ? `Podium ${formatDisplayedVersion(version)}` : 'No version recorded',
      outcome,
      startedRelative:
        started === undefined
          ? 'time not recorded'
          : relativeTime(new Date(started).toISOString(), now),
      ...(started === undefined ? {} : { startedAtLabel: new Date(started).toLocaleString() }),
      ...(started !== undefined && finished !== undefined && finished >= started
        ? { duration: formatDuration(finished - started) }
        : {}),
      ...(operation.error
        ? {
            error: presentOperationError(operation.error as OperationError, {
              operationId: operation.id,
            }),
          }
        : {}),
      ...(operation.retryOf ? { retryNote: 'Retry of an earlier update' } : {}),
    }
  })
}
