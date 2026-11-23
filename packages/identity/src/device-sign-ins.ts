/** Device sign-ins: list, end, create (specification, section 2.7). No token and no hash leaves here. */
import type { Runtime } from './runtime'
import { signToken } from './secrets'
import {
  deleteEarlierSignInsOfDevice,
  deleteSignIn,
  deleteSignInOfAccount,
  deleteSignInsOfAccount,
  deleteSignInsOfAccountExcept,
  type SignInRow,
  signInsOfAccount,
} from './statements'
import {
  type DeviceKind,
  type DeviceSignIn,
  type DeviceSignInOperations,
  IdentityRefused,
} from './types'

export function toDeviceSignIn(row: SignInRow, current: string | undefined): DeviceSignIn {
  return {
    id: row.id,
    accountId: row.accountId,
    kind: row.kind as DeviceKind,
    deviceName: row.deviceName ?? '',
    platform: row.platform ?? 'unknown',
    createdAt: row.createdAt,
    lastSeenAt: row.lastSeenAt,
    expiresAt: row.expiresAt,
    current: row.id === current,
  }
}

export function deviceSignInOperations(runtime: Runtime): DeviceSignInOperations {
  return {
    async listForAccount(accountId, current) {
      const rows = await signInsOfAccount(runtime.db()).run({ accountId, now: runtime.now() })
      return rows.map((row) => toDeviceSignIn(row, current))
    },

    async revoke(id, guard) {
      const [ended] = guard
        ? await deleteSignInOfAccount(runtime.db()).run({ id, accountId: guard.byAccount })
        : await deleteSignIn(runtime.db()).run({ id })
      return { revoked: ended !== undefined, accountId: ended?.accountId ?? null }
    },

    async revokeAllForAccount(accountId, except) {
      const ended =
        except === undefined
          ? await deleteSignInsOfAccount(runtime.db()).run({ accountId })
          : await deleteSignInsOfAccountExcept(runtime.db()).run({ accountId, except })
      return ended.map((row) => row.id)
    },

    async create(accountId, device, delivery, facts, life) {
      const configuration = runtime.configurationFor(facts)
      if (!configuration || (delivery === 'bearer' && facts.scheme !== 'https')) {
        throw new IdentityRefused('https_required')
      }
      const session = await runtime.library.internalAdapter.createSession(
        accountId,
        false,
        {
          ipAddress: facts.clientAddress ?? '',
          userAgent: '',
          deviceKind: device.kind,
          deviceName: device.name ?? null,
          deviceId: device.deviceId ?? null,
          platform: device.platform ?? null,
          fixedExpiry: life?.fixed ?? false,
          ...(life ? { expiresAt: life.expiresAt } : {}),
        },
        // Our values win over the library's defaults, the expiry included.
        true,
      )
      if (!session) throw new Error('identity: the device sign-in was not created')
      if (device.deviceId) {
        await deleteEarlierSignInsOfDevice(runtime.db()).run({
          accountId,
          deviceId: device.deviceId,
          except: session.id,
        })
      }
      const headers = new Headers()
      if (delivery === 'cookie') {
        headers.append(
          'set-cookie',
          runtime.sessionCookie(configuration, session.token, session.expiresAt),
        )
      }
      return {
        deviceSignInId: session.id,
        accountId,
        expiresAt: session.expiresAt,
        headers,
        bearer: delivery === 'bearer' ? signToken(session.token, runtime.config.secret) : null,
      }
    },
  }
}
