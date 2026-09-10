import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  connectivityPath,
  DAEMON_BLOCKED_EXIT_CODE,
  readConnectivityForTest,
  readLiveConnectivity,
  writeConnectivity,
} from './connectivity'
import { defaultInstanceGuardIo } from './instance-guard'

describe('connectivity status file (#19)', () => {
  let dir: string
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'podium-connfile-'))
  })
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it('round-trips a connected status', () => {
    writeConnectivity(
      { state: 'connected', serverUrl: 'wss://relay', lastHelloOkAt: '2026-07-07T00:00:00Z' },
      dir,
    )
    const read = readConnectivityForTest(dir)
    expect(read?.state).toBe('connected')
    expect(read?.serverUrl).toBe('wss://relay')
    expect(read?.lastHelloOkAt).toBe('2026-07-07T00:00:00Z')
    expect(read?.updatedAt).toBeTruthy()
  })

  it('a disconnect keeps lastHelloOkAt/serverUrl but does NOT inherit stale transition fields', () => {
    writeConnectivity(
      { state: 'connected', serverUrl: 'wss://relay', lastHelloOkAt: '2026-07-07T00:00:00Z' },
      dir,
    )
    writeConnectivity(
      { state: 'disconnected', lastError: 'ECONNREFUSED', retryBackoffMs: 500 },
      dir,
    )
    const afterDrop = readConnectivityForTest(dir)
    expect(afterDrop?.lastHelloOkAt).toBe('2026-07-07T00:00:00Z') // "last seen" survives
    expect(afterDrop?.serverUrl).toBe('wss://relay')
    expect(afterDrop?.lastError).toBe('ECONNREFUSED')
    // Reconnecting replaces (not inherits) the error/backoff.
    writeConnectivity({ state: 'connected', lastHelloOkAt: '2026-07-07T00:01:00Z' }, dir)
    const back = readConnectivityForTest(dir)
    expect(back?.state).toBe('connected')
    expect(back?.lastError).toBeUndefined()
    expect(back?.retryBackoffMs).toBeUndefined()
  })

  it('missing or corrupt file reads as undefined (status just omits the line)', () => {
    expect(readConnectivityForTest(dir)).toBeUndefined()
    writeFileSync(connectivityPath(dir), '{nope')
    expect(readConnectivityForTest(dir)).toBeUndefined()
  })

  it('exports the distinct blocked exit code the systemd unit matches', () => {
    expect(DAEMON_BLOCKED_EXIT_CODE).toBe(78)
  })
})

/**
 * POD-3815. `connectivity.json` is ONE file shared by every process that has
 * held this machine's link, and nothing in it is fenced by incarnation. A
 * supervisor refused as superseded (POD-3752) is closed WITHOUT a rejection
 * frame, so it reads the refusal as an ordinary drop, writes `disconnected`
 * and exits — and that record then describes the machine for ever.
 *
 * The reader fence is `processId`: a record whose writer is gone cannot be
 * current, whatever it says. Suppression is only ever on PROOF the writer is
 * dead — an absent `processId` (a pre-POD-3815 writer) still reads as current,
 * because "we cannot tell" must not become "stale".
 */
describe('a dead writer s record is not current (POD-3815)', () => {
  let dir: string
  /** Beyond pid_max — guaranteed not alive. */
  const deadPid = 2 ** 30
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'podium-connlive-'))
  })
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it('suppresses a record whose writer process is gone', () => {
    writeConnectivity({ state: 'disconnected', processId: deadPid, retryBackoffMs: 5_000 }, dir)
    expect(readLiveConnectivity(dir)).toBeUndefined()
  })

  it('keeps a record written by a live process', () => {
    writeConnectivity({ state: 'connected', processId: process.pid }, dir)
    expect(readLiveConnectivity(dir)?.status.state).toBe('connected')
  })

  it('keeps a record that names no writer — absence is not proof of staleness', () => {
    writeConnectivity({ state: 'connected' }, dir)
    expect(readLiveConnectivity(dir)?.status.state).toBe('connected')
  })

  it('leaves the raw read alone, so a successor still inherits the link history', () => {
    writeConnectivity(
      {
        state: 'disconnected',
        processId: deadPid,
        serverUrl: 'wss://relay',
        lastHelloOkAt: '2026-09-10T08:50:57.450Z',
      },
      dir,
    )
    // The successor's first write merges over the predecessor's record, so the
    // fence must NOT reach the raw read `writeConnectivity` merges from — "last
    // contact" would be lost. `readConnectivityForTest` is that raw read.
    expect(readConnectivityForTest(dir)?.lastHelloOkAt).toBe('2026-09-10T08:50:57.450Z')
    const successor = writeConnectivity({ state: 'connected', processId: process.pid }, dir)
    expect(successor.lastHelloOkAt).toBe('2026-09-10T08:50:57.450Z')
    expect(successor.serverUrl).toBe('wss://relay')
  })
})

/**
 * POD-3837. The POD-3815 fence is sound WITHIN a boot — `report()` in
 * `connection-state.ts` rewrites this file on every state transition, so a live
 * writer really does imply a current record. What a bare `kill(pid, 0)` cannot
 * survive is a REBOOT, where every recorded pid is being reused by something
 * unrelated, or a pid recycle, where one is. Then the fence passes a corpse's
 * record through as current — which is precisely the failure the fence exists
 * to stop, deferred to the next boot.
 *
 * The writer stamps the identity triple `instance-guard.ts` already specifies,
 * and the reader compares it. POD-3815's rule is inherited unchanged: what
 * cannot be checked is never read as stale.
 */
describe('a record left by a previous boot is not current (POD-3837)', () => {
  let dir: string
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'podium-connboot-'))
  })
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  /** Stage a raw record, so the test controls the triple the writer stamped. */
  const record = (over: Record<string, unknown>): void => {
    writeFileSync(
      connectivityPath(dir),
      JSON.stringify({ state: 'connected', updatedAt: '2026-09-10T08:50:57.458Z', ...over }),
    )
  }

  it('suppresses a record from before the reboot, though its pid is alive again', () => {
    // `process.pid` is alive by construction: this is exactly the state the
    // bare pid check reads as "the writer is still there".
    record({ processId: process.pid, bootId: 'boot-before-the-reboot' })
    expect(readLiveConnectivity(dir, process.kill, { bootId: () => 'boot-now' })).toBeUndefined()
  })

  it('suppresses a record whose pid was recycled inside one boot', () => {
    record({ processId: process.pid, bootId: 'boot-a', procStartTime: '1000' })
    const io = { bootId: () => 'boot-a', startTime: () => '2000' }
    expect(readLiveConnectivity(dir, process.kill, io)).toBeUndefined()
  })

  it('keeps a record whose writer identity still agrees, and reports it verified', () => {
    record({ processId: process.pid, bootId: 'boot-a', procStartTime: '1000' })
    const io = { bootId: () => 'boot-a', startTime: () => '1000' }
    expect(readLiveConnectivity(dir, process.kill, io)).toEqual({
      status: expect.objectContaining({ state: 'connected' }),
      identityVerified: true,
    })
  })

  it('keeps a pre-triple record on the pid alone, and says the check was weaker', () => {
    record({ processId: process.pid })
    expect(readLiveConnectivity(dir, process.kill, { bootId: () => 'boot-now' })).toEqual({
      status: expect.objectContaining({ state: 'connected' }),
      identityVerified: false,
    })
  })

  it('a record naming no writer is current but never identity-verified', () => {
    record({})
    expect(readLiveConnectivity(dir)?.identityVerified).toBe(false)
  })

  it('the writer stamps its own boot id and start time', () => {
    writeConnectivity({ state: 'connected', processId: process.pid }, dir)
    const raw = readConnectivityForTest(dir)
    expect(raw?.bootId).toBe(defaultInstanceGuardIo.bootId())
    expect(raw?.procStartTime).toBe(defaultInstanceGuardIo.startTime(process.pid))
  })

  it('does not vouch for a pid that is not ours', () => {
    // The stamp is a SELF-attestation. A writer recording someone else's pid
    // cannot say when that process started, and guessing would manufacture the
    // false agreement the triple exists to detect.
    writeConnectivity({ state: 'connected', processId: 2 ** 30 }, dir)
    expect(readConnectivityForTest(dir)?.bootId).toBeUndefined()
    expect(readConnectivityForTest(dir)?.procStartTime).toBeUndefined()
  })

  it('a successor inherits the link history but never the predecessor s identity', () => {
    record({
      processId: 2 ** 30,
      bootId: 'boot-before-the-reboot',
      procStartTime: '1',
      serverUrl: 'wss://relay',
      lastHelloOkAt: '2026-09-10T08:50:57.450Z',
    })
    const successor = writeConnectivity({ state: 'connected', processId: process.pid }, dir)
    expect(successor.lastHelloOkAt).toBe('2026-09-10T08:50:57.450Z')
    expect(successor.bootId).not.toBe('boot-before-the-reboot')
    expect(successor.procStartTime).not.toBe('1')
  })
})
