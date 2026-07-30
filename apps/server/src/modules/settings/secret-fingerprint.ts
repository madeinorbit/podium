/**
 * THE SECRET FINGERPRINT PRODUCER (POD-420) — the thing POD-418 SPECIFIED and
 * deliberately did not build.
 *
 * `SecretPresenceWire.fingerprint` is the one field a replica may hold about a
 * server-owned secret beyond "there is one". The model states the contract and
 * refuses to implement it (`SECRET_FINGERPRINT_CONTRACT`), because `@podium/model`
 * imports nothing but zod and a derivation needing a server-held key has no
 * business in an L0 leaf that ships to browsers. This is that derivation, and it
 * lives on the server because the KEY does.
 *
 * ---------------------------------------------------------------------------
 * WHY A KEYED MAC AND NEVER A DIGEST — the constraint, not a preference
 * ---------------------------------------------------------------------------
 *
 * A provider API key is SHORT and HIGHLY STRUCTURED: `sk-ant-api03-…`,
 * `sk-proj-…`, a Telegram bot token is `<digits>:<35 chars>`. An unsalted digest
 * of one is brute-forceable offline by anyone holding the projection — the
 * search space is the key's own entropy, and the attacker has the format. A
 * "safe" wire field derived that way is a slower spelling of the secret.
 *
 * So the fingerprint is `HMAC-SHA256(serverKey, domain ‖ key ‖ value)`, truncated.
 * The server key never leaves the server, which is what makes the projection
 * useless to anyone who does not already hold it. `secret-fingerprint.test.ts`
 * asserts the negative directly — the output must NOT equal the bare digest of
 * the material, and must CHANGE when the server key changes — because "we used
 * an HMAC" is a claim about the source text and those two are claims about the
 * function.
 *
 * ---------------------------------------------------------------------------
 * WHAT IT MAY SUPPORT, AND THE TRUNCATION
 * ---------------------------------------------------------------------------
 *
 * Exactly one question: *are two configured secrets the same one?* — asked of
 * ONE slot over time ("did the key change when I rotated it?", "does this
 * machine hold what the other one holds?"). That needs collision resistance
 * against ACCIDENT, not against a funded adversary, so 64 bits truncated is
 * ample and the truncation is deliberate: it discards material the question does
 * not need, and every bit not published is a bit not available to anyone
 * attacking the construction later.
 *
 * DOMAIN SEPARATION: the secret's own KEY is part of the MAC message, so the
 * same material configured under `apiKeys.openai` and `apiKeys.anthropic`
 * fingerprints differently. That is a deliberate loss of an answer nobody asked
 * for — "these two slots hold the same string" is a cross-slot equality the
 * presence projection was never asked to publish — and it is the standard
 * defence against a fingerprint minted in one context being replayed as an
 * answer in another.
 *
 * NO CONSUMER MAY COMPARE IT AGAINST A LOCALLY COMPUTED DIGEST, and by
 * construction none can: without the server key there is nothing to compute. A
 * consumer that COULD do it would be a consumer already holding the material.
 */

import { createHmac, randomBytes } from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { SecretPresenceWire, ServerSecretKey } from '@podium/model'
import { stateDir } from '@podium/runtime/config'

/**
 * Bytes of MAC published, before hex encoding. 8 bytes = 64 bits = 16 hex chars.
 *
 * Named rather than inlined so the truncation is a decision with a place to be
 * argued, and so `secret-fingerprint.test.ts` can pin the published width — a
 * fingerprint that silently grew to the full 32 bytes would be publishing 192
 * bits the question does not need.
 */
export const FINGERPRINT_BYTES = 8

/**
 * The field separator inside the MAC message, BUILT rather than written as a
 * literal: a raw NUL in source makes the whole file binary to `grep -n`, which
 * is how content hides from every text instrument in this repo — the failure
 * `check-no-nul-bytes` exists for, and which this file tripped in its first
 * draft.
 *
 * It is not decoration. Joining with a character the inputs can contain would
 * make (`apiKeys.open`, `ai:x`) and (`apiKeys.openai`, `:x`) the SAME message —
 * a canonicalisation collision, which is how a domain-separated MAC stops being
 * separated. No secret key and no settings path contains a NUL.
 */
const SEP = String.fromCharCode(0)

/**
 * The domain tag. Included so a MAC minted here can never be mistaken for — or
 * replayed as — one minted by another use of the same server key. There is only
 * one use today; the tag is what keeps that true when there is a second.
 */
const DOMAIN = 'podium.settings.secret.fingerprint.v1'

/** Filename of the server-held key, in the state dir beside `daemon.secret`. */
export const FINGERPRINT_KEY_FILE = 'secret-fingerprint.key'

/**
 * The server-held MAC key: 32 random bytes, persistent, owner-only.
 *
 * PERSISTENT AND NOT PER-BOOT, deliberately. A per-boot key would re-fingerprint
 * every secret on every restart, and a fingerprint that changes when nothing was
 * rotated answers the ONE question it exists for with a lie — "the key changed"
 * when it did not. Persistence is what makes the field mean anything.
 *
 * `wx` and the re-read on failure are `readOrCreateDaemonSecret`'s shape, for
 * the same reason: two processes sharing a state dir must not have one clobber
 * the other's key, and the loser of the race reads the winner's value. If this
 * file is ever lost, every fingerprint changes once and then stabilises — the
 * material is untouched and nothing is unrecoverable, which is the correct blast
 * radius for a key that authenticates nothing.
 */
export function readOrCreateFingerprintKey(dir: string = stateDir()): Buffer {
  const path = join(dir, FINGERPRINT_KEY_FILE)
  try {
    const existing = readFileSync(path, 'utf8').trim()
    if (existing) return Buffer.from(existing, 'hex')
  } catch {
    // not created yet — fall through and create it
  }
  const key = randomBytes(32)
  mkdirSync(dir, { recursive: true })
  try {
    writeFileSync(path, key.toString('hex'), { mode: 0o600, flag: 'wx' })
    return key
  } catch {
    return Buffer.from(readFileSync(path, 'utf8').trim(), 'hex')
  }
}

/**
 * The fingerprint of one configured secret.
 *
 * THROWS on empty material rather than returning a fingerprint of the empty
 * string. An absent secret has NO fingerprint — `SecretPresenceWire.fingerprint`
 * is `null` for it — and a stable MAC of `''` would be a value every unconfigured
 * slot on every instance shared, i.e. a published constant that reads like a
 * fingerprint. Callers reach {@link secretPresence}, which never asks.
 */
export function secretFingerprint(key: ServerSecretKey, value: string, serverKey: Buffer): string {
  if (value.length === 0) {
    throw new Error(
      'an absent secret has no fingerprint — presence is `false` and fingerprint null',
    )
  }
  return createHmac('sha256', serverKey)
    .update([DOMAIN, key, value].join(SEP))
    .digest('hex')
    .slice(0, FINGERPRINT_BYTES * 2)
}

/**
 * The wire projection for one secret slot — presence, fingerprint, rotation time.
 *
 * Built by NAMING the three members rather than by projecting a stored record,
 * which is the POD-418 property this producer must not undo: `SecretPresenceWire`
 * is not `ServerSecret` with the value stripped, so there is no omit-list here to
 * forget to grow. The `value` parameter is consumed and never returned; the only
 * thing derived from it is the MAC.
 *
 * `''` is today's blob spelling of "not configured" (POD-419 owns removing that
 * ambiguity at rest), so it maps to `present: false` with BOTH nullable members
 * null — never to a fingerprint, and never to a rotation time, because an
 * unconfigured slot was not rotated.
 */
export function secretPresence(
  key: ServerSecretKey,
  value: string,
  serverKey: Buffer,
  updatedAt: string | null = null,
): SecretPresenceWire {
  if (value.length === 0) return { key, present: false, fingerprint: null, updatedAt: null }
  return {
    key,
    present: true,
    fingerprint: secretFingerprint(key, value, serverKey),
    updatedAt,
  }
}
