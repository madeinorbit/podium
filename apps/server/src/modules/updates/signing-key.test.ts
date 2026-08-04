import { createPrivateKey, createPublicKey, sign, verify } from 'node:crypto'
import { mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { readOrCreateUpdateSigningKey } from './signing-key'

const dirs: string[] = []

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

describe('server update signing key', () => {
  it('mints once, persists the pair, and keeps the private file owner-only', () => {
    const dir = mkdtempSync(join(tmpdir(), 'podium-update-key-'))
    dirs.push(dir)

    const first = readOrCreateUpdateSigningKey(dir)
    const second = readOrCreateUpdateSigningKey(dir)

    expect(second).toEqual(first)
    expect(statSync(join(dir, 'update-signing-key.json')).mode & 0o777).toBe(0o600)

    const body = Buffer.from('bundle-bytes')
    const privateKey = createPrivateKey({
      key: Buffer.from(first.privateKey, 'base64'),
      format: 'der',
      type: 'pkcs8',
    })
    const publicKey = createPublicKey({
      key: Buffer.from(first.publicKey, 'base64'),
      format: 'der',
      type: 'spki',
    })
    expect(verify(null, body, publicKey, sign(null, body, privateKey))).toBe(true)
  })

  it('refuses a malformed persisted key instead of rotating the trust root', () => {
    const dir = mkdtempSync(join(tmpdir(), 'podium-update-key-'))
    dirs.push(dir)
    writeFileSync(join(dir, 'update-signing-key.json'), '{"privateKey":"bad","publicKey":"bad"}')

    expect(() => readOrCreateUpdateSigningKey(dir)).toThrow(/invalid persisted update signing key/)
  })
})
