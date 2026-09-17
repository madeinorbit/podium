import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { readValidatedEnrollmentLedger } from './enrollment-ledger-import'

const header = JSON.stringify({ v: 1, kind: 'header', pairingRoot: 'aa'.repeat(32), createdAt: 'now' })
const enroll = (machineId: string, serial: number, ownerUserId: string | null, id = `e-${serial}`) =>
  JSON.stringify({ v: 1, kind: 'enroll', id, machineId, serial, ownerUserId, at: `2026-01-0${serial}` })
const revoke = (machineId: string, serial: number, id = `r-${serial}`) =>
  JSON.stringify({ v: 1, kind: 'revoke', id, machineId, serial, by: null, at: `2026-02-0${serial}` })

function read(lines: string[], trailing = true) {
  const dir = mkdtempSync(join(tmpdir(), 'podium-ledger-'))
  const path = join(dir, 'enrollment.ledger')
  writeFileSync(path, lines.join('\n') + (trailing ? '\n' : ''))
  return readValidatedEnrollmentLedger(path)
}

describe('validated enrollment ledger snapshots', () => {
  it.each([
    ['enroll 1, revoke 1, enroll 2', [enroll('m1', 1, 'u1'), revoke('m1', 1), enroll('m1', 2, 'u2')]],
    ['revoke older than latest enroll', [enroll('m1', 2, 'u2'), revoke('m1', 1)]],
    ['owner update', [enroll('m1', 1, 'u1'), JSON.stringify({ v: 1, kind: 'owner', id: 'o1', machineId: 'm1', ownerUserId: 'u2', at: 'now' })]],
  ])('%s is accepted as a complete validated prefix', (_name, events) => {
    expect(read([header, ...events]).events).toHaveLength(events.length)
  })

  it('tolerates a torn trailing append but refuses an invalid interior record', () => {
    expect(read([header, enroll('m1', 1, 'u1'), '{"v":1'], false).events).toHaveLength(1)
    expect(() => read([header, '{"v":1', enroll('m1', 1, 'u1')])).toThrow(/line 2/)
  })

  it('rejects malformed fields and duplicate ids', () => {
    expect(() => read([header, JSON.stringify({ v: 1, kind: 'enroll', id: 'x', machineId: 'm', serial: 0, ownerUserId: null, at: 'now' })])).toThrow(/serial/)
    expect(() => read([header, enroll('m1', 1, 'u1', 'same'), enroll('m1', 2, 'u2', 'same')])).toThrow(/duplicate event id/)
  })
})
