import { describe, expect, it } from 'vitest'
import { describeGateFailure, rollbackRefusalCode, type GateRefusal } from './update-failure'

describe('health gate sentences', () => {
  const cases: Array<[GateRefusal, string, string]> = [
    [{ child: 'daemon', because: 'refused', reason: 'protocol-mismatch: peer wire version too new' }, 'daemon-refused-wire', 'refused by the server (protocol-mismatch: peer wire version too new)'],
    [{ child: 'daemon', because: 'refused', reason: 'authorization denied' }, 'daemon-refused', 'authorization denied'],
    [{ child: 'daemon', because: 'silent' }, 'daemon-silent', 'did not report healthy'],
    [{ child: 'server', because: 'not-spawned' }, 'server-not-spawned', 'was not spawned'],
    [{ child: 'server', because: 'unspawnable', fault: 'no-lifecycle-channel' }, 'server-unspawnable', 'no-lifecycle-channel'],
    [{ child: 'daemon', because: 'channel-closed' }, 'daemon-channel-closed', 'closed its lifecycle channel'],
    [{ child: 'server', because: 'stopping', reason: 'shutdown requested' }, 'server-stopping', 'shutdown requested'],
    [{ child: 'daemon', because: 'wrong-role', reported: 'server' }, 'daemon-wrong-role', 'wrong role (server)'],
    [{ child: 'server', because: 'wrong-version', reported: '1', expected: '2' }, 'server-wrong-version', 'version 1, expected 2'],
    [{ child: 'server', because: 'no-port' }, 'server-no-port', 'did not report a serving port'],
  ]
  it.each(cases)('describes %j', (refusedBy, reasonCode, cause) => {
    expect(describeGateFailure({ refusedBy })).toEqual({
      reasonCode, detail: expect.stringContaining(cause),
    })
    expect(describeGateFailure({ refusedBy }).detail).toMatch(/^Successor failed its health gate: .+\.$/)
  })
  it('describes missing evidence from older successors', () => {
    expect(describeGateFailure({})).toEqual({ reasonCode: 'successor-unhealthy', detail: expect.stringContaining('did not prove a healthy stack') })
  })
  it.each([
    ['rollback unavailable: this parent cannot tell whether the release carried schema migrations', 'rollback-refused-unknown-migrations'],
    ['rollback unavailable: release carried schema migrations', 'rollback-refused-migrations'],
    ['rollback unavailable: no .old bundle retained to restore', 'rollback-refused-no-bundle'],
  ])('codes %s', (why, code) => expect(rollbackRefusalCode(why)).toBe(code))
})
