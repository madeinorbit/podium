/**
 * Key rotation (POD-7311 acceptance 3): a grant signed with the previous key
 * verifies until it expires; a new key is picked up without a restart.
 */

import { mkdtempSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  CLIENT_GRANT_LIFETIME_MS,
  LiveGrantKeyRing,
  mintLiveGrantKey,
  signClientGrant,
  verifyLiveGrant,
} from './index'
import { LiveGrantKeyFile } from './key-file'

const WS = 'ws_rotate'
const CLAIMS = {
  workspace: WS,
  member: 'user:alice',
  role: 'member',
  sessions: { s1: ['view'] },
  machines: {},
  roots: {},
  logins: [],
} as const

const dirs: string[] = []
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

/** Write the ring atomically, as a secret mount or an operator would. */
function writeRing(path: string, ring: LiveGrantKeyRing, includePrivate: boolean): void {
  writeFileSync(`${path}.tmp`, ring.toJson({ includePrivate }))
  renameSync(`${path}.tmp`, path)
}

describe('key rotation', () => {
  it('keeps verifying the previous key until its grants expire, and picks up the new one live', () => {
    const dir = mkdtempSync(join(tmpdir(), 'live-grant-keys-'))
    dirs.push(dir)
    const corePath = join(dir, 'core.json')
    const roomPath = join(dir, 'room.json')
    let clock = Date.parse('2026-11-23T12:00:00.000Z')
    const now = () => clock

    const previous = mintLiveGrantKey('2026-10')
    writeRing(corePath, new LiveGrantKeyRing([previous]), true)
    writeRing(roomPath, new LiveGrantKeyRing([previous]), false)
    // One Core process and one room node, each started once and never restarted.
    const core = new LiveGrantKeyFile(corePath, { now, checkEveryMs: 5_000 })
    const room = new LiveGrantKeyFile(roomPath, { now, checkEveryMs: 5_000 })
    const verify = (token: string) =>
      verifyLiveGrant(token, { keys: () => room.ring(), workspace: WS, kind: 'client', now: clock })

    const old = signClientGrant(core.ring(), CLAIMS, { now: clock })
    expect(old.keyId).toBe('2026-10')
    expect(verify(old.token).ok).toBe(true)

    // Rotation, step 1: the room learns the new public key first, the old one kept.
    const next = mintLiveGrantKey('2026-11')
    writeRing(roomPath, new LiveGrantKeyRing([next, previous]), false)
    // Step 2: Core signs with the new key, the old one kept after it.
    writeRing(corePath, new LiveGrantKeyRing([next, previous]), true)

    // Before the next look at the file, Core still signs with the old key.
    clock += 1_000
    expect(signClientGrant(core.ring(), CLAIMS, { now: clock }).keyId).toBe('2026-10')

    clock += 5_000
    const fresh = signClientGrant(core.ring(), CLAIMS, { now: clock })
    expect(fresh.keyId).toBe('2026-11')
    expect(verify(fresh.token).ok).toBe(true)
    // The grant the previous key signed still verifies while it lives.
    expect(verify(old.token).ok).toBe(true)

    // Step 3, once the previous key's grants are all past their life: drop it.
    clock = old.expiresAt
    expect(verify(old.token)).toEqual({ ok: false, refusal: 'expired' })
    writeRing(roomPath, new LiveGrantKeyRing([next]), false)
    clock += 5_000
    expect(verify(fresh.token).ok).toBe(true)
    // A key no ring holds any more refuses as unknown, not as expired.
    const lateOld = signClientGrant(new LiveGrantKeyRing([previous]), CLAIMS, { now: clock })
    expect(verify(lateOld.token)).toEqual({ ok: false, refusal: 'unknown-key' })
    expect(fresh.expiresAt - fresh.issuedAt).toBe(CLIENT_GRANT_LIFETIME_MS)
  })

  it('keeps the last good ring when the file changes into something unreadable', () => {
    const dir = mkdtempSync(join(tmpdir(), 'live-grant-keys-'))
    dirs.push(dir)
    const path = join(dir, 'room.json')
    let clock = 0
    const key = mintLiveGrantKey('k1')
    writeRing(path, new LiveGrantKeyRing([key]), false)
    const errors: unknown[] = []
    const file = new LiveGrantKeyFile(path, {
      now: () => clock,
      checkEveryMs: 10,
      onError: (error) => errors.push(error),
    })
    writeFileSync(path, '{"keys": [')
    clock += 10
    expect(file.ring().publicKey('k1')).toBeDefined()
    expect(errors).toHaveLength(1)
    // Repaired: read again on the next look.
    const other = mintLiveGrantKey('k2')
    writeRing(path, new LiveGrantKeyRing([other]), false)
    clock += 10
    expect(file.ring().publicKey('k2')).toBeDefined()
    expect(file.ring().publicKey('k1')).toBeUndefined()
  })
})
