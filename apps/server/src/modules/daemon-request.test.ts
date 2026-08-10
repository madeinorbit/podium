/**
 * THE ONE DAEMON-RPC CORRELATOR'S CONTRACT (POD-318 / POD-1175).
 *
 * The rules that used to be re-implemented per pending map — settle once,
 * clear the timer, resolve the fallback on timeout — plus the one that could not
 * be written at all before the fold: a reply is only accepted from the machine
 * the request was SENT to.
 *
 * The wrong-machine assertions are the point of the suite, so they are written
 * as counterfactuals: each one is preceded (or followed) by the SAME reply from
 * the right machine, proving the instrument can say yes. A refusal-only suite
 * would pass against a broker that settles nothing.
 */

import { SERVER_TRANSFER_MAX_CHUNK_BYTES } from '@podium/protocol'
import type { ControlMessage } from '@podium/protocol'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DaemonRpcService } from './machines/rpc'
import { DaemonRequestBroker, daemonRequestKind } from './daemon-request'

const PROBE = daemonRequestKind<{ answer: string }>('p')
const OTHER = daemonRequestKind<{ answer: string }>('o')

function harness(defaultMachine = 'm1') {
  const sent: { machineId: string; msg: ControlMessage }[] = []
  const broker = new DaemonRequestBroker({
    toMachine: (machineId, msg) => sent.push({ machineId, msg }),
    defaultMachine: () => defaultMachine,
  })
  const ask = (machineId?: string) =>
    broker.request({
      kind: PROBE,
      timeoutMs: 1_000,
      onTimeout: () => ({ answer: 'timeout' }),
      build: (requestId) => ({ type: 'scanRequest', requestId }) as ControlMessage,
      machineId,
    })
  /** The id the broker minted for the Nth send. */
  const idOf = (index: number): string =>
    (sent[index]?.msg as unknown as { requestId: string }).requestId
  return { broker, sent, ask, idOf }
}

beforeEach(() => {
  vi.useFakeTimers()
})

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe('correlation', () => {
  it('sends to the named machine and settles that machine`s answer', async () => {
    const h = harness()
    const p = h.ask('m2')

    expect(h.sent[0]?.machineId).toBe('m2')
    expect(h.broker.settle(PROBE, h.idOf(0), 'm2', { answer: 'ok' })).toBe(true)

    await expect(p).resolves.toEqual({ answer: 'ok' })
  })

  it('targets the default machine when the caller names none, and pins it at SEND time', async () => {
    // The target is a fact about the request, not about the moment the reply
    // arrives: a fleet whose default machine changes mid-flight must not make a
    // late answer from the NEW default settle a request sent to the old one.
    let current = 'm1'
    const sent: { machineId: string; msg: ControlMessage }[] = []
    const broker = new DaemonRequestBroker({
      toMachine: (machineId, msg) => sent.push({ machineId, msg }),
      defaultMachine: () => current,
    })
    const p = broker.request({
      kind: PROBE,
      timeoutMs: 1_000,
      onTimeout: () => ({ answer: 'timeout' }),
      build: (requestId) => ({ type: 'scanRequest', requestId }) as ControlMessage,
    })
    expect(sent[0]?.machineId).toBe('m1')
    const requestId = (sent[0]?.msg as unknown as { requestId: string }).requestId

    current = 'm2'
    vi.spyOn(console, 'error').mockImplementation(() => {})
    expect(broker.settle(PROBE, requestId, 'm2', { answer: 'stolen' })).toBe(false)
    expect(broker.settle(PROBE, requestId, 'm1', { answer: 'ok' })).toBe(true)

    await expect(p).resolves.toEqual({ answer: 'ok' })
  })

  it('mints ids that never collide across request families', () => {
    const h = harness()
    void h.ask()
    void h.broker.request({
      kind: OTHER,
      timeoutMs: 1_000,
      onTimeout: () => ({ answer: 'timeout' }),
      build: (requestId) => ({ type: 'scanRequest', requestId }) as ControlMessage,
    })
    void h.ask()

    expect([h.idOf(0), h.idOf(1), h.idOf(2)]).toEqual(['p0', 'o1', 'p2'])
  })

  it('resolves the caller`s fallback on timeout and forgets the request', async () => {
    const h = harness()
    const p = h.ask('m1')
    expect(h.broker.inFlight).toBe(1)

    await vi.advanceTimersByTimeAsync(1_000)

    await expect(p).resolves.toEqual({ answer: 'timeout' })
    expect(h.broker.inFlight).toBe(0)
    // A late answer to a timed-out request is silently ignored, not a crash.
    expect(h.broker.settle(PROBE, h.idOf(0), 'm1', { answer: 'late' })).toBe(false)
  })

  it('settles once — a duplicate reply is dropped', async () => {
    const h = harness()
    const p = h.ask('m1')

    expect(h.broker.settle(PROBE, h.idOf(0), 'm1', { answer: 'first' })).toBe(true)
    expect(h.broker.settle(PROBE, h.idOf(0), 'm1', { answer: 'second' })).toBe(false)

    await expect(p).resolves.toEqual({ answer: 'first' })
  })

  it('clears the timeout when it settles, so the fallback never lands after an answer', async () => {
    const h = harness()
    const p = h.ask('m1')
    h.broker.settle(PROBE, h.idOf(0), 'm1', { answer: 'ok' })

    await vi.advanceTimersByTimeAsync(5_000)

    await expect(p).resolves.toEqual({ answer: 'ok' })
  })

  it('refuses a reply settled through the WRONG request family', async () => {
    // The runtime half of the typed-token contract: a compile error catches this
    // at the settle site, but a table wired to the wrong family must not resolve
    // a different caller's promise just because the id happens to exist.
    const h = harness()
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const p = h.ask('m1')

    expect(h.broker.settle(OTHER, h.idOf(0), 'm1', { answer: 'wrong family' })).toBe(false)
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining("settled through request family 'o' but it was sent as 'p'"),
    )
    expect(h.broker.settle(PROBE, h.idOf(0), 'm1', { answer: 'ok' })).toBe(true)

    await expect(p).resolves.toEqual({ answer: 'ok' })
  })
})

describe('the answering machine is checked (POD-1175)', () => {
  it('DROPS a reply from a machine other than the one the request was sent to', async () => {
    const h = harness()
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    const p = h.ask('m1')

    expect(h.broker.settle(PROBE, h.idOf(0), 'm2', { answer: 'from the wrong machine' })).toBe(
      false,
    )

    // LOUD: a machine answering for a request it was never sent is either a
    // routing bug or an attempt to serve its own data under this caller's id.
    expect(error).toHaveBeenCalledWith(
      expect.stringContaining("answered by machine 'm2' but sent to 'm1'"),
    )
    // And the honest machine can still answer — the drop did not consume it.
    expect(h.broker.settle(PROBE, h.idOf(0), 'm1', { answer: 'ok' })).toBe(true)
    await expect(p).resolves.toEqual({ answer: 'ok' })
  })

  it('LEAVES the request pending after a wrong-machine reply, so it times out', async () => {
    // Not "fails fast": a wrong answerer must not be able to force even a FAILED
    // resolution, because that would let any attached daemon deny every other
    // machine's RPCs by racing them.
    const h = harness()
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const p = h.ask('m1')

    h.broker.settle(PROBE, h.idOf(0), 'm2', { answer: 'from the wrong machine' })
    expect(h.broker.inFlight).toBe(1)

    await vi.advanceTimersByTimeAsync(1_000)

    await expect(p).resolves.toEqual({ answer: 'timeout' })
  })

  it('does not let one machine`s reply settle a CONCURRENT request to another', async () => {
    // The multi-machine shape the single-daemon deployment hides: two requests
    // in flight, one per machine. Each must be settled only by its own.
    const h = harness()
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const toM1 = h.ask('m1')
    const toM2 = h.ask('m2')

    expect(h.broker.settle(PROBE, h.idOf(0), 'm2', { answer: 'crosstalk' })).toBe(false)
    expect(h.broker.settle(PROBE, h.idOf(1), 'm2', { answer: 'from m2' })).toBe(true)
    expect(h.broker.settle(PROBE, h.idOf(0), 'm1', { answer: 'from m1' })).toBe(true)

    await expect(toM1).resolves.toEqual({ answer: 'from m1' })
    await expect(toM2).resolves.toEqual({ answer: 'from m2' })
  })
})
describe('server transfer RPC', () => {
  it('subdivides source reads into bounded digest-bound chunks on the authenticated target', async () => {
    const sent: { machineId: string; msg: ControlMessage }[] = []
    let rpc!: DaemonRpcService
    rpc = new DaemonRpcService({
      toMachine: (machineId: string, msg: ControlMessage) => {
        sent.push({ machineId, msg })
        const operation =
          msg.type === 'serverTransferPrepareRequest'
            ? 'prepare'
            : msg.type === 'serverTransferChunkRequest'
              ? 'chunk'
              : msg.type === 'serverTransferAcknowledgeRequest'
                ? 'acknowledge'
                : 'status'
        queueMicrotask(() =>
          rpc.settleDaemonReply(machineId, {
            type: 'serverTransferResult',
            requestId: 'requestId' in msg ? msg.requestId : 'missing',
            transferId: 'transfer-1',
            operation,
            ok: true,
            state: 'staging',
            manifestDigest: 'a'.repeat(64),
          }),
        )
      },
      defaultMachine: () => 'source-machine',
    } as never)

    await rpc.serverTransferPrepare(
      {
        transferId: 'transfer-1',
        manifest: {
          formatVersion: 1,
          transferId: 'transfer-1',
          sourceInstanceId: 'source-instance',
          sourceMachineId: 'source-machine',
          targetMachineId: 'target-machine',
          sourceFeedId: 'feed-1',
          sourceFeedEpoch: 'epoch-1',
          appVersion: 'test',
          schemaVersion: 'schema-1',
          packageBytes: 0,
          files: [],
        },
        manifestDigest: 'a'.repeat(64),
      },
      'target-machine',
    )
    const data = Buffer.alloc(SERVER_TRANSFER_MAX_CHUNK_BYTES * 2 + 3)
    await expect(
      rpc.serverTransferChunk(
        { transferId: 'transfer-1', path: 'podium.db', offset: 9, data },
        'target-machine',
      ),
    ).resolves.toMatchObject({ ok: true })

    const prepare = sent[0]?.msg
    expect(prepare).toMatchObject({
      type: 'serverTransferPrepareRequest',
      manifest: {
        transferId: 'transfer-1',
        sourceMachineId: 'source-machine',
        targetMachineId: 'target-machine',
        sourceFeedId: 'feed-1',
        sourceFeedEpoch: 'epoch-1',
        schemaVersion: 'schema-1',
      },
    })
    const chunks = sent
      .map(({ msg }) => msg)
      .filter(
        (msg): msg is Extract<ControlMessage, { type: 'serverTransferChunkRequest' }> =>
          msg.type === 'serverTransferChunkRequest',
      )
    expect(chunks).toHaveLength(3)
    expect(chunks.map((chunk) => chunk.expectedLength)).toEqual([
      SERVER_TRANSFER_MAX_CHUNK_BYTES,
      SERVER_TRANSFER_MAX_CHUNK_BYTES,
      3,
    ])
    expect(chunks.map((chunk) => chunk.offset)).toEqual([
      9,
      9 + SERVER_TRANSFER_MAX_CHUNK_BYTES,
      9 + SERVER_TRANSFER_MAX_CHUNK_BYTES * 2,
    ])
    expect(chunks.every((chunk) => chunk.manifestDigest === 'a'.repeat(64))).toBe(true)
    await expect(
      rpc.serverTransferAcknowledge('transfer-1', 'a'.repeat(64), 'target-machine'),
    ).resolves.toMatchObject({ ok: true })
    expect(sent.at(-1)?.msg).toMatchObject({
      type: 'serverTransferAcknowledgeRequest',
      transferId: 'transfer-1',
      manifestDigest: 'a'.repeat(64),
    })
    expect(sent.every(({ machineId }) => machineId === 'target-machine')).toBe(true)
  })
})
