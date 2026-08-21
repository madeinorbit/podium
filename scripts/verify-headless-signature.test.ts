import { execFileSync } from 'node:child_process'
import { sign as cryptoSign, generateKeyPairSync } from 'node:crypto'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { parseSignatureArgs } from './verify-headless-signature'

/**
 * These exist because this script SHIPPED BROKEN and nothing noticed.
 *
 * The argument filter removed `pubkeyIndex` and `pubkeyIndex + 1` unconditionally, and
 * with `--pubkey` absent `indexOf` returns -1 — so it dropped argv[0], the tarball. The
 * two-argument form exited with a usage error having verified nothing, and that is the
 * ONLY form the published smoke uses. The release-key check standing behind both Mac
 * bundles could never have run, and every release would have ended red.
 *
 * The first test below is that bug, named.
 */
describe('parseSignatureArgs', () => {
  it('keeps the tarball when --pubkey is absent (the form the published smoke uses)', () => {
    expect(parseSignatureArgs(['/tmp/bundle.tar.gz', 'SIGNATURE'])).toEqual({
      ok: true,
      tarball: '/tmp/bundle.tar.gz',
      signature: 'SIGNATURE',
    })
  })

  it('takes the publisher key out without eating a positional argument', () => {
    expect(parseSignatureArgs(['/tmp/bundle.tar.gz', 'SIGNATURE', '--pubkey', 'KEY'])).toEqual({
      ok: true,
      tarball: '/tmp/bundle.tar.gz',
      signature: 'SIGNATURE',
      pubkey: 'KEY',
    })
  })

  it('accepts the flag before the positionals too', () => {
    expect(parseSignatureArgs(['--pubkey', 'KEY', '/tmp/bundle.tar.gz', 'SIGNATURE'])).toEqual({
      ok: true,
      tarball: '/tmp/bundle.tar.gz',
      signature: 'SIGNATURE',
      pubkey: 'KEY',
    })
  })

  it('refuses --pubkey with no value rather than swallowing the signature', () => {
    const parsed = parseSignatureArgs(['/tmp/bundle.tar.gz', 'SIGNATURE', '--pubkey'])
    expect(parsed.ok).toBe(false)
  })

  it('refuses a call that names no tarball or no signature', () => {
    expect(parseSignatureArgs([]).ok).toBe(false)
    expect(parseSignatureArgs(['/tmp/only-a-tarball.tar.gz']).ok).toBe(false)
  })
})

/**
 * End to end through the real script, because the bug above was in the seam between
 * parsing and verifying and a parser test alone would not have caught the exit code the
 * published smoke actually reads.
 */
describe('the script itself', () => {
  const dir = mkdtempSync(join(tmpdir(), 'podium-sigcheck-'))
  afterAll(() => rmSync(dir, { recursive: true, force: true }))

  const bytes = Buffer.from('a headless tarball, for the purposes of argument')
  const tarball = join(dir, 'bundle.tar.gz')
  writeFileSync(tarball, bytes)
  const { privateKey, publicKey } = generateKeyPairSync('ed25519')
  const signature = cryptoSign(null, bytes, privateKey).toString('base64')
  const pubkey = publicKey.export({ format: 'der', type: 'spki' }).toString('base64')

  /** Runs the script, returning its exit status and combined output. */
  const run = (args: string[]): { status: number; output: string } => {
    try {
      const output = execFileSync('bun', ['scripts/verify-headless-signature.ts', ...args], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
      })
      return { status: 0, output }
    } catch (error) {
      const e = error as { status?: number; stdout?: string; stderr?: string }
      return { status: e.status ?? -1, output: `${e.stdout ?? ''}${e.stderr ?? ''}` }
    }
  }

  it('verifies a good signature under a supplied publisher key', () => {
    const { status, output } = run([tarball, signature, '--pubkey', pubkey])
    expect(output).toContain('PASS')
    expect(status).toBe(0)
  })

  it('REJECTS, rather than erroring on usage, when called with two arguments', () => {
    // Exit 2 here is the shipped bug: a usage error means nothing was verified, and the
    // published smoke would read the red as "the release key check failed".
    const { status, output } = run([tarball, signature])
    expect(output).not.toContain('usage:')
    expect(status).toBe(1)
    expect(output).toContain('does NOT verify')
  })

  it('rejects a signature that does not cover these bytes', () => {
    const other = cryptoSign(null, Buffer.from('different bytes'), privateKey).toString('base64')
    const { status, output } = run([tarball, other, '--pubkey', pubkey])
    expect(status).toBe(1)
    expect(output).toContain('does NOT verify')
  })

  it('rejects a good signature under the WRONG key', () => {
    const stranger = generateKeyPairSync('ed25519')
    const strangerKey = stranger.publicKey
      .export({ format: 'der', type: 'spki' })
      .toString('base64')
    const { status } = run([tarball, signature, '--pubkey', strangerKey])
    expect(status).toBe(1)
  })

  it('says so when the tarball is not there', () => {
    const { status, output } = run([join(dir, 'absent.tar.gz'), signature, '--pubkey', pubkey])
    expect(status).toBe(1)
    expect(output).toContain('no such tarball')
  })
})
