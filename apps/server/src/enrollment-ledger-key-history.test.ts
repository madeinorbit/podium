import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { asMachineId } from '@podium/model'
import { afterEach, describe, expect, it } from 'vitest'
import { hasEnrollmentHistory, openEnrollmentLedger } from './enrollment-ledger'

const dirs: string[] = []

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

describe('update-key fleet history witness', () => {
  it('distinguishes first boot from a state root that enrolled a machine', () => {
    const dir = mkdtempSync(join(tmpdir(), 'podium-enrollment-key-history-'))
    dirs.push(dir)

    expect(hasEnrollmentHistory(dir)).toBe(false)
    const ledger = openEnrollmentLedger(dir)
    expect(hasEnrollmentHistory(dir)).toBe(false)
    ledger.appendEnroll({
      id: 'enroll-1',
      machineId: asMachineId('machine-1'),
      serial: 1,
      ownerUserId: null,
      at: '2026-08-26T00:00:00.000Z',
    })
    expect(hasEnrollmentHistory(dir)).toBe(true)
  })
})
