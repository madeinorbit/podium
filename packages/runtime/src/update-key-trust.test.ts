import { generateKeyPairSync } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { readOrCreateUpdateSigningKey, rotateUpdateSigningKey } from './update-signing-key'
import { acceptsUpdateKeyRotation, trustDaemonUpdateKey } from './update-key-trust'

const dirs: string[] = []

function temp(): string {
  const dir = mkdtempSync(join(tmpdir(), 'podium-update-trust-'))
  dirs.push(dir)
  return dir
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

describe('update signing trust', () => {
  it('carries an offline daemon across every old-key-signed rotation', () => {
    const dir = temp()
    const first = readOrCreateUpdateSigningKey(dir)
    rotateUpdateSigningKey(dir)
    const third = rotateUpdateSigningKey(dir)

    expect(readFileSync(join(dir, 'update-signing-key.pub'), 'utf8').trim()).toBe(first.publicKey)
    expect(third.rotations).toHaveLength(2)
    expect(acceptsUpdateKeyRotation(first.publicKey, third.publicKey, third.rotations)).toBe(true)
    expect(
      acceptsUpdateKeyRotation(first.publicKey, third.publicKey, [
        { ...third.rotations[0]!, signature: 'not-a-signature' },
        third.rotations[1]!,
      ]),
    ).toBe(false)
  })

  it('refuses to mint when durable fleet state says a key may already be pinned', () => {
    const dir = temp()
    expect(() => readOrCreateUpdateSigningKey(dir, { allowCreate: false })).toThrow(
      /refusing to mint a replacement/,
    )
  })

  it('detects a deleted private key through its durable public anchor', () => {
    const dir = temp()
    const first = readOrCreateUpdateSigningKey(dir)
    expect(readFileSync(join(dir, 'update-signing-key.pub'), 'utf8').trim()).toBe(first.publicKey)

    unlinkSync(join(dir, 'update-signing-key.json'))
    expect(() => readOrCreateUpdateSigningKey(dir)).toThrow(/refusing to mint a replacement/)

    const replacement = readOrCreateUpdateSigningKey(dir, { confirmNoPins: true })
    expect(replacement.publicKey).not.toBe(first.publicKey)
    expect(readFileSync(join(dir, 'update-signing-key.pub'), 'utf8').trim()).toBe(
      replacement.publicKey,
    )
  })

  it('replaces a pin only through the explicit local recovery function', () => {
    const dir = temp()
    writeFileSync(
      join(dir, 'daemon.json'),
      JSON.stringify({ machineId: 'machine-1', token: 'secret', updatePubkey: 'old' }),
    )
    const replacement = generateKeyPairSync('ed25519')
      .publicKey.export({ format: 'der', type: 'spki' })
      .toString('base64')

    expect(trustDaemonUpdateKey(replacement, dir)).toMatch(/^SHA256:/)
    expect(JSON.parse(readFileSync(join(dir, 'daemon.json'), 'utf8'))).toEqual({
      machineId: 'machine-1',
      token: 'secret',
      updatePubkey: replacement,
    })
    expect(() => trustDaemonUpdateKey('not-a-key', dir)).toThrow()
  })
})
