/** Host recovery and sign-in maintenance, reached only on the user-only control socket. */
import type { DeviceKind, WorkspaceIdentity } from '@podium/identity'
import { LOCAL_DEVICE_SIGN_IN_COOKIE } from '@podium/protocol'
import { ADMIN_PAGE_LIMIT } from './admin-routes'
import type { SignInCarryOver } from './sign-in-carry-over'
import { publicSignIn } from './sign-in-routes'

const DEFAULT_HOST_SIGN_IN_MS = 30 * 24 * 60 * 60 * 1000
const REFUSED = {
  ok: false,
  error:
    'Host recovery requires one member, an active administrator. Sign in with your own account instead.',
} as const

export function hostSignIns(
  identity: WorkspaceIdentity,
  onEnded: (id: string) => void,
  /** Present on a server that carries sign-ins over from before shared sign-in (POD-6751). */
  carryOver?: Pick<SignInCarryOver, 'endByLabel'>,
) {
  const { core } = identity
  async function soleAdminAccount() {
    const members = (await identity.memberships.list()).filter((m) => m.status !== 'removed')
    const [only] = members
    return members.length === 1 && only?.status === 'active' && only.role === 'admin'
      ? only.account?.id
      : undefined
  }

  return {
    async issue(ttlMs = DEFAULT_HOST_SIGN_IN_MS) {
      return await core.transaction(async () => {
        const accountId = await soleAdminAccount()
        if (!accountId) return REFUSED
        const issued = await core.codes.issue({
          purpose: 'host-sign-in',
          accountId,
          createdBy: 'host',
          signInLife: { ttlMs, fixed: true },
        })
        return { ok: true as const, code: issued.code, expiresAt: issued.expiresAt.toISOString() }
      })
    },

    async redeem(code: string) {
      const issued = await core.codes.redeem(
        {
          code,
          purpose: 'host-sign-in',
          accountAllowed: async (accountId) => (await soleAdminAccount()) === accountId,
        },
        { kind: 'host', name: 'Host recovery session' },
        'cookie',
        { scheme: 'http', sameMachine: true, clientAddress: null },
      )
      if (!issued || issued === 'pending') {
        return { ok: false as const, error: 'This host recovery code is unavailable.' }
      }
      // The CLI uses the same signed value as the browser, but stores it in
      // its owner-readable state directory instead of a browser cookie jar.
      const prefix = LOCAL_DEVICE_SIGN_IN_COOKIE + '='
      const cookie = issued.headers.getSetCookie().find((value) => value.startsWith(prefix))
      if (!cookie) throw new Error('Host sign-in did not issue a cookie')
      const token = decodeURIComponent(cookie.slice(prefix.length).split(';', 1)[0] ?? '')
      return { ok: true as const, token, expiresAt: issued.expiresAt.toISOString() }
    },

    async list() {
      // Keep the control response within the CLI's bounded response reader.
      const { signIns, total } = await identity.listDeviceSignIns({ limit: ADMIN_PAGE_LIMIT })
      return { ok: true as const, signIns: signIns.map(publicSignIn), total }
    },

    async revoke(kind: DeviceKind) {
      const ended = await core.transaction(async () => {
        const ids = await identity.revokeDeviceSignInsByKind(kind)
        // Host sessions minted before shared sign-in end with them (R17).
        if (kind === 'host') await carryOver?.endByLabel('break-glass')
        return ids
      })
      for (const id of ended) onEnded(id)
      return { ok: true as const, revoked: ended.length }
    },
  }
}

export type HostSignIns = ReturnType<typeof hostSignIns>
