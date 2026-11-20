/** The receipt in each release folder (POD-7268, design §5.2 and §7). */
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  type InstallReceipt,
  parseReleaseFolderName,
  RECEIPT_FILE,
  readInstallReceipt,
  releaseFolderName,
  writeInstallReceipt,
} from './install-receipt'

let dir: string

const good: InstallReceipt = {
  format: 1,
  harness: 'claude-code',
  version: '2.1.311',
  executable: 'claude',
  integrity: { kind: 'sha256', digest: 'c'.repeat(64), publishedAt: '2026-11-01T00:00:00.000Z' },
  source: 'https://downloads.example.com/claude-code/2.1.311/linux-x64/claude',
  installedAt: '2026-11-02T03:04:05.000Z',
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'install-receipt-'))
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

describe('receipt.json', () => {
  it('round-trips and leaves no temporary file behind', () => {
    writeInstallReceipt(dir, good)
    expect(readInstallReceipt(dir)).toEqual({ ok: true, receipt: good })
    expect(readdirSync(dir)).toEqual([RECEIPT_FILE])
  })

  it('accepts an install with no checksum when it says why', () => {
    const none = {
      ...good,
      integrity: { kind: 'none' as const, reason: 'vendor publishes no checksum' },
    }
    writeInstallReceipt(dir, none)
    expect(readInstallReceipt(dir)).toEqual({ ok: true, receipt: none })
  })

  it.each([
    ['an absolute executable', { executable: '/usr/bin/claude' }],
    ['an executable outside the folder', { executable: '../claude' }],
    ['a version unsafe as a folder name', { version: '../2.1' }],
    ['an unknown harness', { harness: 'emacs' }],
    ['a source that is not a URL', { source: 'somewhere' }],
  ])('refuses to write %s', (_name, change) => {
    expect(() => writeInstallReceipt(dir, { ...good, ...change } as InstallReceipt)).toThrow()
  })

  it('reports a missing, unparsable or invalid receipt without throwing', () => {
    expect(readInstallReceipt(dir)).toMatchObject({
      ok: false,
      error: expect.stringContaining('no readable'),
    })
    writeFileSync(join(dir, RECEIPT_FILE), '{ not json')
    expect(readInstallReceipt(dir)).toMatchObject({
      ok: false,
      error: expect.stringContaining('not JSON'),
    })
    writeFileSync(join(dir, RECEIPT_FILE), JSON.stringify({ ...good, format: 2 }))
    expect(readInstallReceipt(dir)).toMatchObject({
      ok: false,
      error: expect.stringContaining('invalid'),
    })
  })
})

describe('release folder names', () => {
  it('are <number>-<version>', () => {
    expect(releaseFolderName(7, '2.1.311')).toBe('7-2.1.311')
    expect(parseReleaseFolderName('7-2.1.311')).toEqual({ number: 7, version: '2.1.311' })
    expect(parseReleaseFolderName('12-0.167.2-beta.1')).toEqual({
      number: 12,
      version: '0.167.2-beta.1',
    })
  })

  it('skip staging folders and other names', () => {
    expect(parseReleaseFolderName('.staging-4f2a')).toBeUndefined()
    expect(parseReleaseFolderName('ledger.db')).toBeUndefined()
    expect(parseReleaseFolderName('0-1.0.0')).toBeUndefined()
  })

  it('refuse a number below one or an unsafe version', () => {
    expect(() => releaseFolderName(0, '1.0.0')).toThrow()
    expect(() => releaseFolderName(1, 'a/b')).toThrow()
  })
})
