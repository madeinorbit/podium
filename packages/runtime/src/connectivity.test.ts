import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  connectivityPath,
  DAEMON_BLOCKED_EXIT_CODE,
  readConnectivity,
  writeConnectivity,
} from './connectivity'

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
    const read = readConnectivity(dir)
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
    writeConnectivity({ state: 'disconnected', lastError: 'ECONNREFUSED', retryBackoffMs: 500 }, dir)
    const afterDrop = readConnectivity(dir)
    expect(afterDrop?.lastHelloOkAt).toBe('2026-07-07T00:00:00Z') // "last seen" survives
    expect(afterDrop?.serverUrl).toBe('wss://relay')
    expect(afterDrop?.lastError).toBe('ECONNREFUSED')
    // Reconnecting replaces (not inherits) the error/backoff.
    writeConnectivity({ state: 'connected', lastHelloOkAt: '2026-07-07T00:01:00Z' }, dir)
    const back = readConnectivity(dir)
    expect(back?.state).toBe('connected')
    expect(back?.lastError).toBeUndefined()
    expect(back?.retryBackoffMs).toBeUndefined()
  })

  it('missing or corrupt file reads as undefined (status just omits the line)', () => {
    expect(readConnectivity(dir)).toBeUndefined()
    writeFileSync(connectivityPath(dir), '{nope')
    expect(readConnectivity(dir)).toBeUndefined()
  })

  it('exports the distinct blocked exit code the systemd unit matches', () => {
    expect(DAEMON_BLOCKED_EXIT_CODE).toBe(78)
  })
})
