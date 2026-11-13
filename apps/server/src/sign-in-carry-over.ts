// LEGACY(remove-after: 2027-06): the sign-in carry-over; removing it signs out every browser, desktop app and host session that still holds only a cookie from before shared sign-in.
/**
 * THE SIGN-IN CARRY-OVER (POD-6751; docs/design/sign-in-carry-over.md).
 *
 * A browser that was signed in before the upgrade to shared sign-in still
 * holds the old cookie. The first time it asks `GET /auth/status`, its old
 * sign-in is EXCHANGED for a device sign-in: the old row is deleted and the
 * device sign-in is created in one transaction, and the answer sets the new
 * cookie. Nobody types a password because of the upgrade.
 *
 * WHAT THIS MODULE MUST NEVER DO, because it honours an old credential on
 * purpose:
 *
 * - It never resolves an old cookie to a member. An old cookie only ever
 *   turns into a device sign-in cookie, and that cookie goes through the one
 *   resolution path (`memberOfRequest`).
 * - It carries in one place, `carry`, called by the status route alone (R1).
 * - One old sign-in becomes at most one device sign-in (R10). For ten minutes
 *   the same old token gets the same answer again and creates nothing (R12).
 * - Nothing but the token chooses the member (R15).
 *
 * It exists only on a server that built its own identity core (R3). Every
 * statement it runs is in `store/sign-in-carry-over.ts`.
 */
import { createCipheriv, createDecipheriv, createHash, hkdfSync, randomBytes } from 'node:crypto'
import type { ConnectionFacts, DeviceDescription, WorkspaceIdentity } from '@podium/identity'
import { createLogger } from '@podium/logger'
import type { UserId } from '@podium/model'
import { SESSION_COOKIE } from '@podium/protocol'
import type { MemberOfRequest, MemberResolution } from './identity/member-of-request'
import { browserSignInDevice } from './sign-in-device'
import type {
  ConsumedOldSignIn,
  HonouredLabel,
  SignInCarryOverRepository,
} from './store/sign-in-carry-over'

const log = createLogger('server:sign-in-carry-over')

/** The period: how long after the upgrade an old sign-in can still be carried (R6). */
export const CARRY_OVER_PERIOD_MS = 30 * 24 * 60 * 60 * 1000
/** How long the same old token gets the same answer again (R12). */
export const CARRY_REPEAT_MS = 10 * 60 * 1000

/** An old token is 43 base64url characters; anything of another form is not looked up. */
const OLD_TOKEN = /^[A-Za-z0-9_-]{20,512}$/
const SEAL_INFO = 'podium/sign-in-carry-over/v1'

export interface CarriedAnswer {
  /** The resolution of the new cookie, through the one resolution path. */
  resolution: MemberResolution
  /** The `Set-Cookie` values of the device sign-in. */
  setCookies: string[]
}

export interface SignInCarryOver {
  /**
   * For `GET /auth/status` only. Answers undefined when nothing is carried:
   * the route then answers exactly as it would without the old cookie.
   */
  carry(
    request: Request,
    facts: ConnectionFacts,
    resolution: MemberResolution,
  ): Promise<CarriedAnswer | undefined>
  /** Whatever ends all device sign-ins of a member ends their old ones too (R16). */
  endForMember(memberId: UserId): Promise<void>
  /** Ending a kind of sign-in from the host ends the old ones of its label (R17). */
  endByLabel(label: HonouredLabel): Promise<void>
  /**
   * Sign-out: deletes the old sign-in of the cookie this request carries (R18).
   * True when the request carries an old cookie, so the route clears it.
   */
  endForCookie(request: Request): Promise<boolean>
  /** Hourly: expired old sign-ins and carry records; everything once the period ended. */
  sweep(): Promise<void>
  /** At boot, before the server listens: fixes the end of the period, once. */
  start(): Promise<{ endsAt: string; oldSignIns: number }>
}

export interface SignInCarryOverDeps {
  store: SignInCarryOverRepository
  identity: WorkspaceIdentity
  memberOfRequest: MemberOfRequest
  /** Whether an `Origin` header value may act on this server for this request. */
  originAllowed(origin: string, request: Request): boolean
  /** One audit row, in the caller's transaction. */
  audit(command: string, actor: UserId, detail: Record<string, unknown>): Promise<void>
  now?: () => Date
}

/** The value of the cookie named `podium_session`, and of no other (R2). */
function oldCookieOf(request: Request): string | undefined {
  const header = request.headers.get('cookie')
  if (!header) return undefined
  for (const part of header.split(';')) {
    const equals = part.indexOf('=')
    if (equals < 0) continue
    if (part.slice(0, equals).trim() === SESSION_COOKIE) return part.slice(equals + 1).trim()
  }
  return undefined
}

const hashOf = (token: string): string => createHash('sha256').update(token).digest('hex')

const sealKey = (token: string, salt: Buffer): Buffer =>
  Buffer.from(hkdfSync('sha256', token, salt, SEAL_INFO, 32))

/**
 * The answer of a carry, encrypted with a key only the old token yields. The
 * server cannot open a record by itself, and a copy of the database holds a
 * ciphertext whose key it does not contain.
 */
export function sealCarriedAnswer(token: string, tokenHash: string, setCookies: string[]): string {
  const salt = randomBytes(16)
  const nonce = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', sealKey(token, salt), nonce)
  cipher.setAAD(Buffer.from(tokenHash))
  const ciphertext = Buffer.concat([
    cipher.update(JSON.stringify(setCookies), 'utf8'),
    cipher.final(),
  ])
  return Buffer.concat([salt, nonce, ciphertext, cipher.getAuthTag()]).toString('base64url')
}

/** Undefined for a record this token does not open, whatever the reason. */
export function openCarriedAnswer(
  token: string,
  tokenHash: string,
  sealed: string,
): string[] | undefined {
  try {
    const bytes = Buffer.from(sealed, 'base64url')
    if (bytes.length < 16 + 12 + 16) return undefined
    const decipher = createDecipheriv(
      'aes-256-gcm',
      sealKey(token, bytes.subarray(0, 16)),
      bytes.subarray(16, 28),
    )
    decipher.setAAD(Buffer.from(tokenHash))
    decipher.setAuthTag(bytes.subarray(bytes.length - 16))
    const plain = Buffer.concat([
      decipher.update(bytes.subarray(28, bytes.length - 16)),
      decipher.final(),
    ]).toString('utf8')
    const parsed: unknown = JSON.parse(plain)
    return Array.isArray(parsed) && parsed.every((value) => typeof value === 'string')
      ? parsed
      : undefined
  } catch {
    return undefined
  }
}

/** What kind of device an old sign-in was, and how long its device sign-in lives (section 4.2). */
function deviceOf(
  old: ConsumedOldSignIn,
  request: Request,
): { device: DeviceDescription; life?: { expiresAt: Date; fixed: boolean } } {
  if (old.label === 'break-glass') {
    // The expiry its operator chose, never renewed, as before the upgrade.
    return {
      device: { kind: 'host', name: 'Host session' },
      life: { expiresAt: new Date(old.expiresAt), fixed: true },
    }
  }
  if (old.label === 'mobile') {
    return {
      device: {
        kind: 'phone',
        ...(old.deviceName ? { name: old.deviceName } : {}),
        ...(old.deviceId ? { deviceId: old.deviceId } : {}),
        ...(old.platform ? { platform: old.platform } : {}),
      },
    }
  }
  const desktop = old.deviceId === 'desktop'
  // A row from before sign-ins had names is named from this request.
  const described = browserSignInDevice(
    request.headers.get('user-agent') ?? undefined,
    request.headers.get('origin') ?? undefined,
    desktop,
  )
  return {
    device: {
      kind: desktop ? 'desktop' : 'browser',
      name: old.deviceName ?? described.name,
      platform: old.platform ?? described.platform,
    },
  }
}

/** The request again, carrying the new cookies in place of its own. */
function withCookies(request: Request, setCookies: string[]): Request {
  const headers = new Headers(request.headers)
  headers.set('cookie', setCookies.map((value) => value.split(';', 1)[0]).join('; '))
  return new Request(request.url, { method: 'GET', headers })
}

export function createSignInCarryOver(deps: SignInCarryOverDeps): SignInCarryOver {
  const { store, identity, memberOfRequest } = deps
  const now = deps.now ?? (() => new Date())
  /** The end of the period, read once at start. Until then nothing is carried. */
  let endsAtMs = Number.NEGATIVE_INFINITY
  /** Set at start and by the sweep: both tables are empty and stay so. */
  let ended = true

  const periodOver = (): boolean => ended || now().getTime() >= endsAtMs

  async function carry(
    request: Request,
    facts: ConnectionFacts,
    resolution: MemberResolution,
  ): Promise<CarriedAnswer | undefined> {
    // Section 4.1. A request that has a device sign-in is never touched (R4).
    const withoutDeviceSignIn =
      resolution.kind === 'unauthenticated' ||
      (resolution.kind === 'member' && resolution.deviceSignIn === null)
    if (!withoutDeviceSignIn) return undefined
    const token = oldCookieOf(request)
    if (token === undefined || !OLD_TOKEN.test(token)) return undefined
    if (facts.scheme !== 'https' && !facts.sameMachine) return undefined
    const origin = request.headers.get('origin')
    if (origin !== null && !deps.originAllowed(origin, request)) return undefined
    if (periodOver()) return undefined

    const tokenHash = hashOf(token)
    // A cookie that matches no old sign-in and no carry record ends here,
    // after two reads and without a write (R14). This read decides nothing
    // else: whether a sign-in is carried is decided by the consuming
    // statement inside the transaction.
    if (!(await store.matches(tokenHash, now().toISOString()))) return undefined
    const setCookies = await store.transaction(async (): Promise<string[] | undefined> => {
      const at = now()
      // CONSUME. The row is gone in the statement that finds it.
      const old = await store.consume(tokenHash, at.toISOString())
      if (!old) return await repeat(request, token, tokenHash, at)

      // MEMBER. Only an active membership that names an account (R7). For
      // anybody else the old sign-in is gone and nothing is issued.
      const accountId = await identity.memberships.accountOfActiveMember(old.memberId)
      if (accountId === undefined) return undefined

      // ISSUE. An ordinary device sign-in (R19).
      const { device, life } = deviceOf(old, request)
      const issued = await identity.core.deviceSignIns.create(
        accountId,
        device,
        'cookie',
        facts,
        life,
      )
      const cookies = issued.headers.getSetCookie()

      // RECORD, so the same token gets this same answer for ten minutes.
      await store.record({
        oldTokenHash: tokenHash,
        deviceSignInId: issued.deviceSignInId,
        sealed: sealCarriedAnswer(token, tokenHash, cookies),
        expiresAt: new Date(at.getTime() + CARRY_REPEAT_MS).toISOString(),
        memberId: old.memberId,
        oldLabel: old.label,
      })

      // AUDIT. No token, no hash, no address.
      await deps.audit('members.signInCarried', old.memberId, {
        memberId: old.memberId,
        label: old.label,
        deviceSignInId: issued.deviceSignInId,
      })
      return cookies
    })
    if (!setCookies || setCookies.length === 0) return undefined
    return { resolution: await memberOfRequest(withCookies(request, setCookies)), setCookies }
  }

  /** Section 4.3: no old row. Creates nothing; its only write is deleting a dead record. */
  async function repeat(
    request: Request,
    token: string,
    tokenHash: string,
    at: Date,
  ): Promise<string[] | undefined> {
    const sealed = await store.sealedOf(tokenHash, at.toISOString())
    if (sealed === undefined) return undefined
    const cookies = openCarriedAnswer(token, tokenHash, sealed)
    if (!cookies || cookies.length === 0) return undefined
    const resolution = await memberOfRequest(withCookies(request, cookies))
    if (resolution.kind !== 'member' || resolution.deviceSignIn === null) {
      // The sign-in was ended, or the membership is no longer active.
      await store.forget(tokenHash)
      return undefined
    }
    return cookies
  }

  return {
    carry,
    endForMember: (memberId) => store.endForMember(memberId),
    endByLabel: (label) => store.endByLabel(label),

    async endForCookie(request) {
      const token = oldCookieOf(request)
      if (token === undefined) return false
      if (OLD_TOKEN.test(token)) await store.endForToken(hashOf(token))
      return true
    },

    async sweep() {
      const at = now()
      if (ended) return
      if (at.getTime() >= endsAtMs) {
        await store.deleteEverything()
        ended = true
        return
      }
      await store.deleteExpired(at.toISOString())
    },

    async start() {
      return await store.transaction(async () => {
        const at = now()
        const oldSignIns = await store.countHonoured()
        let endsAt = await store.periodEnd()
        if (endsAt === undefined) {
          // Never changed afterwards. With no old sign-in there is nothing to wait for.
          endsAt = new Date(
            at.getTime() + (oldSignIns > 0 ? CARRY_OVER_PERIOD_MS : 0),
          ).toISOString()
          await store.writePeriodEndIfAbsent(endsAt)
          log.info('sign-in carry-over: old sign-ins are honoured until the end of the period', {
            endsAt,
            oldSignIns,
          })
        }
        endsAtMs = Date.parse(endsAt)
        ended = !(at.getTime() < endsAtMs)
        if (ended) await store.deleteEverything()
        return { endsAt, oldSignIns }
      })
    },
  }
}
