/**
 * THE FINGERPRINT IS A KEYED MAC, PROVED AS A PROPERTY OF THE FUNCTION.
 *
 * "We used an HMAC" is a claim about source text, and a reviewer reading
 * `createHmac` is reading the same source text. The two assertions that make
 * this file worth having are claims about the OUTPUT:
 *
 *   1. it is NOT the bare digest of the material (any spelling of one), and
 *   2. it CHANGES when the server key changes.
 *
 * Together those are unsatisfiable by a digest, which is the construction
 * POD-418 forbade. A test that only checked "same input, same output" would pass
 * against `sha256(value).slice(0, 16)` — the exact thing being ruled out.
 */

import { createHash, randomBytes } from 'node:crypto'
import { mkdtempSync, readFileSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  FINGERPRINT_BYTES,
  FINGERPRINT_KEY_FILE,
  readOrCreateFingerprintKey,
  secretFingerprint,
  secretPresence,
} from './secret-fingerprint'

const SERVER_KEY = Buffer.from('a'.repeat(64), 'hex')
const OTHER_KEY = Buffer.from('b'.repeat(64), 'hex')
const MATERIAL = 'sk-ant-api03-not-a-real-key'

describe('the fingerprint is a truncated KEYED mac', () => {
  it('is stable for the same key, material and server key', () => {
    expect(secretFingerprint('apiKeys.anthropic', MATERIAL, SERVER_KEY)).toBe(
      secretFingerprint('apiKeys.anthropic', MATERIAL, SERVER_KEY),
    )
  })

  it('is 16 hex characters — the declared truncation, not the whole mac', () => {
    const fp = secretFingerprint('apiKeys.anthropic', MATERIAL, SERVER_KEY)
    expect(fp).toMatch(/^[0-9a-f]+$/)
    expect(fp.length).toBe(FINGERPRINT_BYTES * 2)
    expect(fp.length).toBe(16)
  })

  it('CHANGES when the server key changes — this is what a digest cannot do', () => {
    expect(secretFingerprint('apiKeys.anthropic', MATERIAL, SERVER_KEY)).not.toBe(
      secretFingerprint('apiKeys.anthropic', MATERIAL, OTHER_KEY),
    )
  })

  it('is NOT the bare digest of the material, in any of the obvious spellings', () => {
    const fp = secretFingerprint('apiKeys.anthropic', MATERIAL, SERVER_KEY)
    const digests = [
      createHash('sha256').update(MATERIAL).digest('hex'),
      createHash('sha256').update(`apiKeys.anthropic ${MATERIAL}`).digest('hex'),
      createHash('sha512').update(MATERIAL).digest('hex'),
      createHash('md5').update(MATERIAL).digest('hex'),
    ]
    for (const digest of digests) {
      expect(fp).not.toBe(digest)
      expect(fp).not.toBe(digest.slice(0, 16))
    }
  })

  it('CHANGES on rotation — the one question it exists to answer', () => {
    expect(secretFingerprint('apiKeys.anthropic', MATERIAL, SERVER_KEY)).not.toBe(
      secretFingerprint('apiKeys.anthropic', `${MATERIAL}-rotated`, SERVER_KEY),
    )
  })

  it('is DOMAIN SEPARATED — the same material in two slots fingerprints differently', () => {
    expect(secretFingerprint('apiKeys.openai', MATERIAL, SERVER_KEY)).not.toBe(
      secretFingerprint('apiKeys.anthropic', MATERIAL, SERVER_KEY),
    )
  })

  it('discloses nothing of the material by inspection', () => {
    const fp = secretFingerprint('apiKeys.anthropic', MATERIAL, SERVER_KEY)
    expect(fp).not.toContain('sk-')
    expect(MATERIAL).not.toContain(fp)
  })

  it('REFUSES empty material — an absent secret has no fingerprint', () => {
    expect(() => secretFingerprint('apiKeys.openai', '', SERVER_KEY)).toThrow(/no fingerprint/)
  })
})

describe('the presence projection carries presence, a mac and a time — and no material', () => {
  it('a configured secret is present with a fingerprint', () => {
    const wire = secretPresence('apiKeys.openai', MATERIAL, SERVER_KEY, '2026-07-30T00:00:00.000Z')
    expect(wire).toEqual({
      key: 'apiKeys.openai',
      present: true,
      fingerprint: secretFingerprint('apiKeys.openai', MATERIAL, SERVER_KEY),
      updatedAt: '2026-07-30T00:00:00.000Z',
    })
  })

  it('has exactly the three members plus the join key — no value key to strip', () => {
    const wire = secretPresence('apiKeys.openai', MATERIAL, SERVER_KEY)
    expect(Object.keys(wire).sort()).toEqual(['fingerprint', 'key', 'present', 'updatedAt'])
    // The material is consumed and never returned, at any nesting.
    expect(JSON.stringify(wire)).not.toContain(MATERIAL)
  })

  it("today's `''` spelling of absence is present:false with BOTH nullables null", () => {
    expect(secretPresence('apiKeys.openai', '', SERVER_KEY, '2026-07-30T00:00:00.000Z')).toEqual({
      key: 'apiKeys.openai',
      present: false,
      fingerprint: null,
      updatedAt: null,
    })
  })
})

describe('the server-held key is persistent and owner-only', () => {
  const dir = (): string => mkdtempSync(join(tmpdir(), 'podium-fp-'))

  it('creates it once and returns the SAME key on the next call', () => {
    const d = dir()
    const first = readOrCreateFingerprintKey(d)
    const second = readOrCreateFingerprintKey(d)
    expect(first.toString('hex')).toBe(second.toString('hex'))
    expect(first.length).toBe(32)
  })

  it('writes it 0600 — the same posture as daemon.secret', () => {
    const d = dir()
    readOrCreateFingerprintKey(d)
    expect(statSync(join(d, FINGERPRINT_KEY_FILE)).mode & 0o777).toBe(0o600)
  })

  it('two state dirs get DIFFERENT keys, so fingerprints do not cross instances', () => {
    const a = readOrCreateFingerprintKey(dir())
    const b = readOrCreateFingerprintKey(dir())
    expect(a.toString('hex')).not.toBe(b.toString('hex'))
  })

  it('persistence is what makes rotation detectable — a fresh key would change everything', () => {
    // The positive control for the paragraph in the module doc: with the SAME
    // stored key, an unrotated secret keeps its fingerprint across "restarts".
    const d = dir()
    const before = secretFingerprint('apiKeys.openai', MATERIAL, readOrCreateFingerprintKey(d))
    const after = secretFingerprint('apiKeys.openai', MATERIAL, readOrCreateFingerprintKey(d))
    expect(after).toBe(before)
    // …and a DIFFERENT state dir (a lost key file) changes it, which is the
    // blast radius the doc names.
    expect(
      secretFingerprint('apiKeys.openai', MATERIAL, readOrCreateFingerprintKey(dir())),
    ).not.toBe(before)
  })

  it('the stored file is the key and nothing else', () => {
    const d = dir()
    const key = readOrCreateFingerprintKey(d)
    expect(readFileSync(join(d, FINGERPRINT_KEY_FILE), 'utf8')).toBe(key.toString('hex'))
  })

  it('a random 32-byte key really is what production uses', () => {
    // Guard against a default that silently degraded to a constant: two fresh
    // keys must differ, and the generator under test is the module's own.
    expect(randomBytes(32).length).toBe(32)
    expect(readOrCreateFingerprintKey(dir()).toString('hex')).not.toBe(
      readOrCreateFingerprintKey(dir()).toString('hex'),
    )
  })
})
