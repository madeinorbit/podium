/**
 * One-time codes (specification, sections 1.5, 2.8 and 12).
 *
 * A code names an account; the device sign-in is created by the statement group
 * that redeems it. So no sign-in exists for a code that is never redeemed, and
 * an account with no login method needs no sign-in first.
 */
import { timingSafeEqual } from 'node:crypto'
import type { Runtime } from './runtime'
import { defaultPhrase, isGeneratedIdentifier, newPublicId, newSecret, sha256Hex } from './secrets'
import {
  accountById,
  authoriseAttempt,
  type CodeRow,
  claimPairingCode,
  codeById,
  consumeByClaim,
  consumeByCode,
  consumeResetCode,
  decideCode,
  deleteRedeemedCode,
  deleteSignInsOfAccount,
  deleteUnusedCodesOfAccount,
  discardTransferClaim,
  insertCode,
  insertPasswordMethod,
  liveResetCode,
  openAttemptByChallenge,
  pendingClaim,
  recordWrongVerifier,
  signInById,
  updatePassword,
} from './statements'
import {
  type CodeStatus,
  type DeviceDescription,
  type DeviceSignInOperations,
  IdentityRefused,
  type OneTimeCodeOperations,
} from './types'

const MINUTE = 60_000
const LIFETIME_MS = {
  'pair-device': 2 * MINUTE,
  'password-reset': 24 * 60 * MINUTE,
  'host-sign-in': MINUTE,
  'transfer-claim': 10 * MINUTE,
} as const
const HAND_OVER_ATTEMPT_MS = 10 * MINUTE
const HAND_OVER_CODE_MS = 3 * MINUTE
const LONGEST_MS = 24 * 60 * MINUTE

/** What the `device` column holds: the receiving device and how its sign-in is made. */
interface StoredDevice {
  device?: DeviceDescription
  delivery?: 'cookie' | 'bearer'
  phrase?: [string, string, string]
  /** The lifetime the issuer chose for the sign-in (a host session). */
  life?: { ttlMs: number; fixed: boolean }
}

function storedDevice(row: CodeRow): StoredDevice {
  if (!row.device) return {}
  try {
    return JSON.parse(row.device) as StoredDevice
  } catch {
    return {}
  }
}

function sameHash(a: string, b: string): boolean {
  const left = Buffer.from(a)
  const right = Buffer.from(b)
  return left.length === right.length && timingSafeEqual(left, right)
}

/** Ends a redemption and rolls its transaction back. `wrongVerifierOf`: count it against that row. */
class Refused extends Error {
  constructor(readonly wrongVerifierOf?: string) {
    super('identity: redemption refused')
  }
}

export function oneTimeCodeOperations(
  runtime: Runtime,
  deviceSignIns: DeviceSignInOperations,
): OneTimeCodeOperations {
  return {
    async issue(input) {
      const now = runtime.now()
      const ttl = Math.min(Math.max(input.ttlMs ?? LIFETIME_MS[input.purpose], 1), LONGEST_MS)
      const expiresAt = new Date(now.getTime() + ttl)
      const id = newPublicId()
      const code = newSecret()
      const stored: StoredDevice = input.signInLife ? { life: input.signInLife } : {}
      await insertCode(runtime.db()).run({
        id,
        purpose: input.purpose,
        accountId: input.accountId,
        codeHash: sha256Hex(code),
        receiverChallenge: null,
        device: input.signInLife ? JSON.stringify(stored) : null,
        createdBy: input.createdBy,
        now,
        expiresAt,
      })
      return { id, code, expiresAt }
    },

    async claim(input) {
      const claimId = newPublicId()
      const phrase = (input.phrase ?? defaultPhrase)(claimId, input.challenge)
      const stored: StoredDevice = {
        device: { ...input.device, kind: 'phone' },
        delivery: input.delivery,
        phrase,
      }
      const [claimed] = await claimPairingCode(runtime.db()).run({
        codeHash: sha256Hex(input.code),
        now: runtime.now(),
        claimId,
        challenge: input.challenge,
        device: JSON.stringify(stored),
      })
      return claimed ? { claimId, phrase, expiresAt: claimed.expiresAt } : undefined
    },

    async status(id, accountId): Promise<CodeStatus> {
      const [row] = await codeById(runtime.db()).run({ id })
      if (!row || row.accountId !== accountId || row.purpose !== 'pair-device') {
        return { state: 'expired' }
      }
      if (row.consumedAt) return { state: 'completed' }
      if (row.approval === 'denied') return { state: 'denied' }
      if (row.expiresAt.getTime() <= runtime.now().getTime()) return { state: 'expired' }
      const stored = storedDevice(row)
      if (!row.claimId || !stored.device || !stored.delivery || !stored.phrase) {
        return { state: 'pending', expiresAt: row.expiresAt }
      }
      return {
        state: row.approval === 'approved' ? 'approved' : 'claimed',
        expiresAt: row.expiresAt,
        device: stored.device,
        delivery: stored.delivery,
        phrase: stored.phrase,
      }
    },

    async decide(id, accountId, decision) {
      const decided = await decideCode(runtime.db()).run({
        id,
        accountId,
        decision,
        now: runtime.now(),
      })
      return decided.length > 0
    },

    async discardTransferClaim(id) {
      await discardTransferClaim(runtime.db()).run({ id })
    },

    async begin(input) {
      const now = runtime.now()
      const id = newPublicId()
      const expiresAt = new Date(now.getTime() + HAND_OVER_ATTEMPT_MS)
      await insertCode(runtime.db()).run({
        id,
        purpose: input.purpose,
        accountId: null,
        codeHash: null,
        receiverChallenge: input.challenge,
        device: null,
        createdBy: null,
        now,
        expiresAt,
      })
      return { id, expiresAt }
    },

    async authorise(input) {
      const now = runtime.now()
      const [source] = await signInById(runtime.db()).run({ id: input.sourceSignInId, now })
      if (!source || source.accountId !== input.accountId) return undefined
      return await runtime.transaction(async () => {
        const [attempt] = await openAttemptByChallenge(runtime.db()).run({
          challenge: input.challenge,
          now,
        })
        if (!attempt) return 'ended'
        // At most three minutes, and never beyond the attempt or the authorising sign-in.
        const expiresAt = new Date(
          Math.min(
            now.getTime() + HAND_OVER_CODE_MS,
            attempt.expiresAt.getTime(),
            source.expiresAt.getTime(),
          ),
        )
        const code = runtime.config.handOverCode?.() ?? newSecret()
        const [bound] = await authoriseAttempt(runtime.db()).run({
          id: attempt.id,
          now,
          accountId: input.accountId,
          codeHash: sha256Hex(code),
          sourceSignInId: source.id,
          expiresAt,
        })
        return bound ? { code, expiresAt } : 'ended'
      })
    },

    async redeem(input, device, delivery, facts) {
      if (!runtime.configurationFor(facts) || (delivery === 'bearer' && facts.scheme !== 'https')) {
        throw new IdentityRefused('https_required')
      }
      const now = runtime.now()
      function requireVerifier(row: CodeRow) {
        if (!row.receiverChallenge) return
        if (!input.verifier) throw new Refused()
        if (!sameHash(sha256Hex(input.verifier), row.receiverChallenge)) throw new Refused(row.id)
      }
      try {
        return await runtime.transaction(async () => {
          // Step 1: the one statement that consumes. No row: nothing happened.
          const [row] =
            'claimId' in input
              ? await consumeByClaim(runtime.db()).run({ claimId: input.claimId, now })
              : await consumeByCode(runtime.db()).run({ codeHash: sha256Hex(input.code), now })
          if (!row) {
            if ('claimId' in input) {
              const [waiting] = await pendingClaim(runtime.db()).run({
                claimId: input.claimId,
                now,
              })
              if (
                waiting &&
                (storedDevice(waiting).delivery === 'cookie' || delivery === 'bearer')
              ) {
                requireVerifier(waiting)
                return 'pending' as const
              }
            }
            return undefined
          }
          const stored = storedDevice(row)
          // A route can redeem only its own purpose. A pairing claim keeps
          // the delivery channel chosen at claim time; it cannot turn a
          // native bearer into a browser response or vice versa.
          if ('code' in input) {
            if (row.purpose === 'pair-device' || (input.purpose && input.purpose !== row.purpose)) {
              throw new Refused()
            }
          } else if (
            row.purpose !== 'pair-device' ||
            !stored.delivery ||
            (stored.delivery === 'bearer' && delivery !== 'bearer')
          ) {
            throw new Refused()
          }
          // Step 2: a receiver-bound code needs the receiver's own verifier.
          requireVerifier(row)
          let life: { expiresAt: Date; fixed: boolean } | undefined
          if (row.purpose === 'hand-over') {
            // Step 3: the authorising sign-in must still exist; the new one ends with it.
            const [source] = row.sourceSignInId
              ? await signInById(runtime.db()).run({ id: row.sourceSignInId, now })
              : []
            if (!source) throw new Refused()
            life = { expiresAt: source.expiresAt, fixed: true }
          } else if (stored.life) {
            life = {
              expiresAt: new Date(now.getTime() + stored.life.ttlMs),
              fixed: stored.life.fixed,
            }
          }
          // Step 4: the account must still exist and, with local accounts, may sign in.
          const accountId = row.accountId as string
          const [account] = await accountById(runtime.db()).run({ id: accountId })
          if (!account) throw new Refused()
          if ('code' in input && input.accountAllowed && !(await input.accountAllowed(accountId))) {
            throw new Refused()
          }
          if (runtime.signInGate && !(await runtime.signInGate(accountId))) throw new Refused()
          // Step 5: the device sign-in.
          const claimed = row.purpose === 'pair-device'
          const described: DeviceDescription = claimed
            ? { ...(stored.device ?? device), kind: 'phone' }
            : row.purpose === 'host-sign-in'
              ? { ...device, kind: 'host' }
              : device
          const issued = await deviceSignIns.create(
            accountId,
            described,
            claimed ? (stored.delivery ?? delivery) : delivery,
            facts,
            life,
          )
          // Pairing keeps a short-lived completion marker so the approving
          // device can update its screen. These direct exchanges need none.
          if (row.purpose === 'host-sign-in' || row.purpose === 'transfer-claim') {
            await deleteRedeemedCode(runtime.db()).run({ id: row.id })
          }
          return issued
        })
      } catch (error) {
        if (!(error instanceof Refused)) throw error
        // The transaction rolled back and consumed nothing. A wrong verifier is
        // counted in a transaction of its own; the fifth denies the attempt.
        if (error.wrongVerifierOf) {
          await recordWrongVerifier(runtime.db()).run({ id: error.wrongVerifierOf })
          if ('claimId' in input) input.onWrongVerifier?.()
        }
        return undefined
      }
    },

    async inspectPasswordReset(code) {
      const [row] = await liveResetCode(runtime.db()).run({
        codeHash: sha256Hex(code),
        now: runtime.now(),
      })
      if (!row) return undefined
      return {
        accountId: row.accountId,
        email: isGeneratedIdentifier(row.email) ? null : row.email,
        expiresAt: row.expiresAt,
      }
    },

    async redeemPasswordReset(input) {
      const codeHash = sha256Hex(input.code)
      // Only a live code is worth a password hash, which is slow on purpose and
      // is made before the transaction opens.
      const live = await liveResetCode(runtime.db()).run({ codeHash, now: runtime.now() })
      if (live.length === 0) return undefined
      const hash = await runtime.hashPassword(input.password)
      return await runtime.transaction(async () => {
        const now = runtime.now()
        const [row] = await consumeResetCode(runtime.db()).run({ codeHash, now })
        if (!row?.accountId) return undefined
        const accountId = row.accountId
        const updated = await updatePassword(runtime.db()).run({ accountId, password: hash, now })
        if (updated.length === 0) {
          await insertPasswordMethod(runtime.db()).run({
            id: runtime.newId('account'),
            accountId,
            password: hash,
            now,
          })
        }
        // Every device sign-in of the account ends, the one using the link included.
        const ended = await deleteSignInsOfAccount(runtime.db()).run({ accountId })
        // So does every code that could still mint one: other reset links and
        // pairing codes, approved or not (POD-6754 finding F3).
        await deleteUnusedCodesOfAccount(runtime.db()).run({ accountId })
        return { accountId, endedSignInIds: ended.map((row) => row.id) }
      })
    },
  }
}
