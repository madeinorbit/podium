// Part of the Agent Runtime contract (POD-4386). See ./index.ts for the
// surface's five governing rules and ./procedures.ts for the generic compositions.

import type { TranscriptItem } from '@podium/model'
import type { AgentSessionHandle, RuntimeDriver } from './driver.js'
import { DriverRefusalError, type TurnEvent } from './errors.js'
import type { ProcedureOptions } from './procedures.js'
import { genericAskAndAwait, genericOneShot, readFullTranscript } from './procedures.js'
import type { SessionSpec } from './session-spec.js'
import type { TurnInput } from './turns.js'

// ---------------------------------------------------------------------------
// Durable headless identity (POD-4386)
//
// The legacy headless port (apps/daemon/src/control/headless.ts,
// durable-headless.ts) fenced every turn on four things the generic contract
// could not name: a digest over the immutable facts, an exact account
// fingerprint, a stable turn id for replay-without-rerun, and an original
// creation timestamp for the deadline. This module names them so the two
// production callers (superagent, shipwright) can migrate without losing the
// guarantees the deletion lane (POD-4279) depends on.
// ---------------------------------------------------------------------------

/** The durable identity of one headless turn. All three must match for a replay
 *  to be legal; any mismatch is a refusal, never a rerun. */
export interface HeadlessTurnIdentity {
  turnId: string
  requestDigest: string
  accountId: string
}

export interface HeadlessDurableResult {
  ok: boolean
  error?: string
  harnessSessionId?: string
  output?: string
  requestDigest: string
  accountId: string
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null'
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  const record = value as Record<string, unknown>
  return `{${Object.keys(record)
    .filter((key) => record[key] !== undefined)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
    .join(',')}}`
}

/**
 * Canonical bytes for the contract-level headless digest.
 *
 * Covers the immutable turn facts the server mints and the daemon fences:
 * prompt, model/effort overrides, tool policy, permission, MCP, conversation
 * ids and the durable session/account identity. Transport ids (rowId, RPC
 * requestId) deliberately do not affect it — a reconnect replays the SAME turn,
 * not a new one.
 */
export function canonicalHeadlessContractFacts(input: {
  prompt: string
  model?: string
  effort?: string
  allowedTools?: readonly string[]
  permissionMode?: string
  toolPolicy?: 'none'
  mcpConfig?: string
  resumeValue?: string
  sessionUuid?: string
  turnId: string
  sessionId: string
  accountId: string
}): string {
  return canonicalJson(input)
}



// ---------------------------------------------------------------------------
// Durable journal port (in-memory for tests, filesystem on the daemon)
// ---------------------------------------------------------------------------

/** What the journal must retain for reconnect-replay-without-rerun. */
export interface HeadlessJournalEntry {
  identity: HeadlessTurnIdentity
  result: HeadlessDurableResult
  createdAt: number
}

export interface HeadlessJournal {
  read(turnId: string): HeadlessJournalEntry | undefined
  write(entry: HeadlessJournalEntry): void
  /** Delete only on exact identity match; throws otherwise. */
  acknowledge(identity: HeadlessTurnIdentity): void
  createdAt(turnId: string): number | undefined
  recordCreatedAt(turnId: string, now: number): void
}

export function createMemoryHeadlessJournal(): HeadlessJournal {
  const entries = new Map<string, HeadlessJournalEntry>()
  const births = new Map<string, number>()
  return {
    read: (turnId) => entries.get(turnId),
    write: (entry) => {
      entries.set(entry.identity.turnId, entry)
    },
    acknowledge: (identity) => {
      const existing = entries.get(identity.turnId)
      if (!existing) return
      if (
        existing.identity.requestDigest !== identity.requestDigest ||
        existing.identity.accountId !== identity.accountId
      ) {
        throw new Error('refusing mismatched durable headless acknowledgement')
      }
      entries.delete(identity.turnId)
      births.delete(identity.turnId)
    },
    createdAt: (turnId) => births.get(turnId),
    recordCreatedAt: (turnId, now) => {
      if (!births.has(turnId)) births.set(turnId, now)
    },
  }
}

// ---------------------------------------------------------------------------
// Guards (each armed by a dedicated negative test)
// ---------------------------------------------------------------------------

/** Digest fence: a turn whose facts do not hash to its digest is refused. */
export function assertHeadlessDigest(
  actualDigest: string,
  expectedDigest: string,
): void {
  if (actualDigest !== expectedDigest) {
    throw new DriverRefusalError(
      { reason: 'invalid_value', detail: 'headless request digest mismatch' },
      'headless digest',
    )
  }
}

/** Account fence: a turn under the wrong native login is refused. */
export function assertHeadlessAccount(actual: string, expected: string): void {
  if (actual !== expected) {
    throw new DriverRefusalError(
      { reason: 'invalid_value', detail: 'headless result identity mismatch' },
      'headless account',
    )
  }
}

/** Tool-policy fence: `toolPolicy: 'none'` on a harness that cannot enforce it. */
export function assertHeadlessNoTools(
  toolPolicy: TurnInput['toolPolicy'],
  canEnforce: boolean,
  harness: string,
): void {
  if (toolPolicy === 'none' && !canEnforce) {
    throw new Error(`harness ${harness} cannot enforce a no-tools headless turn`)
  }
}

/** Native-account fence for tool-less turns: exact `native:<agent>:<fp>` match. */
export function assertNativeHeadlessAccountId(
  agent: string,
  accountId: string,
): void {
  if (!accountId.startsWith(`native:${agent}:`)) {
    throw new Error(`tool-less headless turn requires an exact native ${agent} account fingerprint`)
  }
}

// ---------------------------------------------------------------------------
// Procedures
// ---------------------------------------------------------------------------

export interface HeadlessAskOptions extends ProcedureOptions {
  /** Stable turn id for replay-without-rerun. Required. */
  turnId: string
  /** Durable journal for replay/ack/deadline. Defaults to a fresh memory journal
   *  (no cross-restart replay) when absent. */
  journal?: HeadlessJournal
  /** Clock for deadline preservation. Defaults to Date.now. */
  now?: () => number
  /** Whether the harness can enforce `toolPolicy: 'none'`. Defaults to true;
   *  pass false to exercise the refusal arm. */
  canEnforceNoTools?: boolean
  /** Harness name for diagnostics (defaults to the session spec harness). */
  harness?: string
}

export interface HeadlessTurnOutcome {
  terminal: TurnEvent
  /** Transcript items after the fence (completed, any verdict). */
  items: readonly TranscriptItem[]
  /** Durable result token for ack (digest + account). */
  receipt: { requestDigest: string; accountId: string; harnessSessionId?: string }
}

/**
 * send + await with the headless durable fences.
 *
 * - Digest/account are verified BEFORE the send (mismatch refuses, never runs).
 * - A journaled result for the same turnId+identity replays WITHOUT rerun.
 * - A journaled result for the same turnId with DIFFERENT identity refuses.
 * - The timeout preserves the ORIGINAL deadline: `createdAt` is recorded on
 *   first dispatch and a reconnect computes the remainder, never a fresh budget.
 * - Interrupt requests a fence; the fence arrives on the event stream.
 * - The turn identity travels on the send as `TurnInput.id` (the same field the
 *   WS relay maps the frame's `turnId` onto): defaulted from `options.turnId`
 *   when absent, and a divergent pre-set id is a caller bug that throws rather
 *   than forking the journal key from the driver's replay key.
 */
export async function headlessAskAndAwait(
  handle: AgentSessionHandle,
  input: TurnInput,
  options: HeadlessAskOptions,
): Promise<HeadlessTurnOutcome> {
  const journal = options.journal ?? createMemoryHeadlessJournal()
  const now = options.now ?? Date.now
  const turnId = options.turnId
  if (!turnId) throw new Error('headlessAskAndAwait requires a stable turnId')
  if (input.id !== undefined && input.id !== turnId) {
    throw new Error('headlessAskAndAwait turnId and TurnInput.id disagree')
  }
  const turnInput = input.id === undefined ? { ...input, id: turnId } : input

  const requestDigest = input.requestDigest ?? ''
  const accountId = input.accountId ?? ''
  if (!requestDigest || !accountId) {
    throw new DriverRefusalError(
      { reason: 'invalid_value', detail: 'headless turn requires requestDigest and accountId' },
      'headless identity',
    )
  }

  // Replay-without-rerun: a completed journal entry for this exact identity
  // satisfies the wait with no send. A same-turnId entry with a DIFFERENT
  // identity is a mismatch, never a reuse.
  const previous = journal.read(turnId)
  if (previous) {
    if (
      previous.identity.requestDigest !== requestDigest ||
      previous.identity.accountId !== accountId
    ) {
      throw new DriverRefusalError(
        { reason: 'invalid_value', detail: 'durable headless replay identity mismatch' },
        'headless replay',
      )
    }
    const items = await readFullTranscript(handle, 1000)
    return {
      terminal:
        previous.result.ok
          ? { ev: 'completed', turnEpoch: 0, verdict: 'done' }
          : { ev: 'failed', turnEpoch: 0, reason: 'provider-error', disposition: 'fatal' },
      items,
      receipt: {
        requestDigest: previous.result.requestDigest,
        accountId: previous.result.accountId,
        ...(previous.result.harnessSessionId
          ? { harnessSessionId: previous.result.harnessSessionId }
          : {}),
      },
    }
  }

  // Tool-policy fence before dispatch.
  const harness = options.harness ?? 'unknown'
  assertHeadlessNoTools(input.toolPolicy, options.canEnforceNoTools ?? true, harness)
  if (input.toolPolicy === 'none') {
    assertNativeHeadlessAccountId(harness, accountId)
  }

  // Original deadline after restart: first dispatch records createdAt; a
  // reconnect reuses it and waits only the remainder.
  let createdAt = journal.createdAt(turnId)
  if (createdAt === undefined) {
    createdAt = now()
    journal.recordCreatedAt(turnId, createdAt)
  }
  const requestedTimeout = options.timeoutMs
  const elapsed = now() - createdAt
  const effectiveTimeout =
    requestedTimeout !== undefined ? Math.max(1, requestedTimeout - elapsed) : undefined

  const terminal = await genericAskAndAwait(handle, turnInput, {
    ...(options.origin ? { origin: options.origin } : {}),
    ...(options.delivery ? { delivery: options.delivery } : {}),
    ...(options.principal ? { principal: options.principal } : {}),
    ...(options.signal ? { signal: options.signal } : {}),
    ...(effectiveTimeout !== undefined ? { timeoutMs: effectiveTimeout } : {}),
  })

  const items = await readFullTranscript(handle, 1000)
  const harnessSessionId = handle.binding.resume?.value
  const result: HeadlessDurableResult = {
    ok: terminal.ev !== 'failed',
    ...(terminal.ev === 'failed' ? { error: `${terminal.reason}${terminal.detail ? `: ${terminal.detail}` : ''}` } : {}),
    ...(harnessSessionId ? { harnessSessionId } : {}),
    requestDigest,
    accountId,
  }
  journal.write({ identity: { turnId, requestDigest, accountId }, result, createdAt })

  return {
    terminal,
    items,
    receipt: {
      requestDigest,
      accountId,
      ...(harnessSessionId ? { harnessSessionId } : {}),
    },
  }
}

/** Acknowledge (release) a durable headless result. Only an exact identity match
 *  deletes; anything else throws and retains. */
export function headlessAcknowledge(
  journal: HeadlessJournal,
  identity: HeadlessTurnIdentity,
): void {
  journal.acknowledge(identity)
}

export interface HeadlessOneShotOptions extends HeadlessAskOptions {
  historyLimit?: number
}

/**
 * ephemeral create → headlessAskAndAwait → kill.
 *
 * The session carries `spec` (workdir, sticky model, MCP, instructions, env);
 * the prompt travels as the one turn's text with per-turn headless policy on
 * `turn`. Returns the turn's transcript items on `completed` (any verdict).
 * Throws on `failed` and on refused sends. The handle is killed in every path.
 */
export async function headlessOneShot(
  driver: RuntimeDriver,
  spec: SessionSpec,
  prompt: string,
  turn: TurnInput,
  options: HeadlessOneShotOptions,
): Promise<HeadlessTurnOutcome> {
  const handle = await driver.create(spec)
  try {
    const outcome = await headlessAskAndAwait(handle, { ...turn, text: prompt }, options)
    if (outcome.terminal.ev === 'failed') {
      throw new Error(
        `headless one-shot turn failed (${outcome.terminal.reason})${outcome.terminal.detail ? `: ${outcome.terminal.detail}` : ''}`,
      )
    }
    return outcome
  } finally {
    await handle.kill().catch(() => undefined)
  }
}
