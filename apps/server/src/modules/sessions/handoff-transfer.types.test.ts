/**
 * THE STAGE-TOKEN BOUNDARY, DEFENDED — POD-1171, adopting POD-642/POD-381's form.
 *
 * The rename is the readable half of this issue; this file is the half that can
 * FAIL. Renaming `sessionId` to `stageToken` documents that two of the three
 * transfer paths never carry a session, but a name cannot refuse anything, and
 * the thing that needed refusing was already compiling: `MachineRpc` and
 * `HandoffRpcPort` both declared `handoffWriteChunk(sessionId: SessionId, …)`
 * while satisfying a port whose parameter is `SessionId | ws-${string} |
 * ref-${string}`. TypeScript accepted it because METHOD-syntax parameters are
 * checked bivariantly — the one variance rule in the language that is unsound by
 * design — so an implementation could swear it only handles session ids and still
 * be handed a `ws-` fetch token by `workspace.ts`.
 *
 * The fix is that both ports now declare `handoffWriteChunk` with PROPERTY
 * syntax, which `strictFunctionTypes` (repo-wide `strict: true`) checks
 * CONTRAVARIANTLY. The probes below are what keep that from silently reverting:
 * `@ts-expect-error` on a directive with nothing left to suppress is itself a
 * compile error (TS2578), so if someone rewrites either port back to a method,
 * the compiler reports HERE, by name, instead of quietly re-opening the hole.
 *
 * VERIFIED BY MUTATION, not by reasoning: with `handoffWriteChunk` written as a
 * method on `HandoffTransferRpc`, `_narrowedWriterIsRefused` below stops erroring
 * and TS2578 names this line. That mutation is the whole reason to trust the
 * probe — an undefended `@ts-expect-error` is indistinguishable from a passing
 * one until you make it lie.
 */

import type { SessionId } from '@podium/model'
import { describe, expect, it } from 'vitest'
import type { HandoffStageToken, HandoffTransferRpc } from './handoff-transfer'
import type { HandoffRpcPort } from './handoff/ports'

type ChunkResult = Promise<{ ok: boolean; sizeBytes?: number; error?: string }>

/**
 * THE REFUSAL. A writer that accepts only session ids cannot serve this pipe,
 * because `workspace.ts` sends it `ws-` and `ref-` tokens. This is precisely the
 * assignment that compiled before POD-1171 — at `machines/rpc.ts` and at
 * `handoff/ports.ts`, both reached by real callers, not a hypothetical.
 */
// @ts-expect-error a SessionId-only chunk writer cannot accept a ws-/ref- stage token
const _narrowedWriterIsRefused: HandoffTransferRpc['handoffWriteChunk'] = (
  _sessionId: SessionId,
  _offset: number,
  _data: Buffer,
  _machineId: string,
): ChunkResult => Promise.resolve({ ok: true })

/**
 * THE SAME REFUSAL AT THE OTHER PORT. `workspace.ts` does not pass a `MachineRpc`
 * to `transferHandoffPackage` — it passes `this.ports.rpc`, a `HandoffRpcPort`.
 * Fixing only the concrete rpc would have left the hole standing one indirection
 * behind the port, so both are probed.
 */
// @ts-expect-error the handoff port's chunk writer must admit every stage token too
const _narrowedPortWriterIsRefused: HandoffRpcPort['handoffWriteChunk'] = (
  _sessionId: SessionId,
  _offset: number,
  _data: Buffer,
  _machineId: string,
): ChunkResult => Promise.resolve({ ok: true })

/**
 * THE ACCEPTING SIDE, so neither refusal above can be read as a parameter type
 * that simply refuses everything — which would satisfy both directives and prove
 * nothing. A writer typed for the token accepts all three producers.
 */
const _tokenWriterIsAccepted: HandoffTransferRpc['handoffWriteChunk'] = (
  _stageToken: HandoffStageToken,
  _offset: number,
  _data: Buffer,
  _machineId: string,
): ChunkResult => Promise.resolve({ ok: true })

/** The three id spaces this pipe actually carries, each assignable to the token. */
const _sessionToken: HandoffStageToken = 'sess-abc' as SessionId
const _workspaceFetchToken: HandoffStageToken = 'ws-7f3c1a2b4d5e6'
const _baseRefToken: HandoffStageToken = 'ref-7f3c1a2b4d5e6'

/**
 * AND THE NARROWING IS STILL REFUSED IN THE OTHER DIRECTION: a stage token is not
 * a session id. This is the half POD-362 already held — a `ws-` fetch id must not
 * launder into `SessionId` — and it is asserted here because the widening this
 * issue performed is exactly the kind of change that could have given it away.
 */
// @ts-expect-error a workspace-fetch stage token is not a session id
const _tokenIsNotASessionId: SessionId = 'ws-7f3c1a2b4d5e6'

describe('handoff transfer: the stage token is not a session id', () => {
  it('refuses a chunk writer narrowed to SessionId, at both ports', () => {
    // The VALUES are meaningless — these bindings exist to be type-checked. Their
    // presence is what matters: an unreferenced binding invites a cleanup that
    // would take the probe with it.
    expect(_narrowedWriterIsRefused).toBeTypeOf('function')
    expect(_narrowedPortWriterIsRefused).toBeTypeOf('function')
    expect(_tokenWriterIsAccepted).toBeTypeOf('function')
  })

  it('carries all three producers, and still refuses to call a token a session', () => {
    expect([_sessionToken, _workspaceFetchToken, _baseRefToken]).toEqual([
      'sess-abc',
      'ws-7f3c1a2b4d5e6',
      'ref-7f3c1a2b4d5e6',
    ])
    expect(_tokenIsNotASessionId).toBe('ws-7f3c1a2b4d5e6')
  })
})
