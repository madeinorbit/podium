/**
 * The core: the object the package builds from an edition configuration
 * (specification, section 2.3).
 */
import { accountOperations } from './accounts'
import { capabilitiesOf } from './capabilities'
import { oneTimeCodeOperations } from './codes'
import { credentialOperations } from './credentials'
import { deviceSignInOperations } from './device-sign-ins'
import { createMembershipEngine } from './membership/engine'
import { deleteExpiredInvitations } from './membership/statements'
import { workspaceIdentity } from './membership/workspace'
import { CLIENT_ADDRESS_HEADER, createRuntime, type Runtime } from './runtime'
import { signInOperations } from './sign-in'
import { accountForAuthentication, deleteExpiredCodes } from './statements'
import type { IdentityConfig, IdentityCore } from './types'

/** Headers a proxy or a caller may have set; none of them reaches the library. */
const FORWARDING_HEADERS = [
  'forwarded',
  'x-forwarded-for',
  'x-forwarded-host',
  'x-forwarded-proto',
  'x-forwarded-port',
  'x-real-ip',
  'cf-connecting-ip',
  'true-client-ip',
  CLIENT_ADDRESS_HEADER,
]

export async function createIdentityCore(config: IdentityConfig): Promise<IdentityCore> {
  return (await buildIdentity(config)).core
}

/**
 * The core together with its runtime. Not part of the public entry: the
 * memberships module and the shared suite build on the runtime's transaction.
 */
export async function buildIdentity(
  config: IdentityConfig,
): Promise<{ core: IdentityCore; runtime: Runtime }> {
  const runtime = await createRuntime(config)
  const capabilities = capabilitiesOf(config)
  const credentials = credentialOperations(runtime)
  const deviceSignIns = deviceSignInOperations(runtime)
  const accounts = accountOperations(runtime)
  // Installs the sign-in gate of local accounts and the account hook.
  const memberships = createMembershipEngine(runtime)

  const core: IdentityCore = {
    capabilities: () => capabilities,
    accounts,
    signIn: signInOperations(runtime, credentials),
    deviceSignIns,
    codes: oneTimeCodeOperations(runtime, deviceSignIns),
    credentials: { resolve: credentials.resolve, renew: credentials.renew },
    workspace(id, members) {
      return workspaceIdentity(memberships, memberships.bind(id, members), core, credentials)
    },
    async sweep() {
      const now = runtime.now()
      await deleteExpiredCodes(runtime.db()).run({ now })
      await deleteExpiredInvitations(runtime.db()).run({ now })
    },
    transaction: (fn) => runtime.transaction(fn),
  }

  if (config.libraryRoutes) {
    core.libraryHandler = async (request, facts) => {
      const configuration = runtime.configurationFor(facts)
      if (!configuration) {
        return Response.json({ error: 'https_required' }, { status: 400 })
      }
      // The library learns the client address from the facts alone.
      const headers = new Headers(request.headers)
      for (const name of FORWARDING_HEADERS) headers.delete(name)
      if (facts.clientAddress) headers.set(CLIENT_ADDRESS_HEADER, facts.clientAddress)
      const incoming = new URL(request.url)
      const path = incoming.pathname.slice(configuration.basePath.length)
      if (path === '/verify-email') {
        if (request.method !== 'POST') return new Response(null, { status: 405 })
        if (incoming.search) return new Response(null, { status: 400 })
        const origin = request.headers.get('origin')
        if (
          origin !== configuration.origin &&
          (config.hosts.kind !== 'fixed' || origin !== config.hosts.appOrigin)
        ) {
          return new Response(null, { status: 403 })
        }
        if (!headers.get('content-type')?.startsWith('application/json'))
          return new Response(null, { status: 415 })
        let body: unknown
        try {
          body = await request.json()
        } catch {
          return new Response(null, { status: 400 })
        }
        if (
          !body ||
          typeof body !== 'object' ||
          !('token' in body) ||
          typeof body.token !== 'string' ||
          !body.token ||
          body.token.length > 8192
        ) {
          return new Response(null, { status: 400 })
        }
        const password = 'password' in body ? body.password : undefined
        if (password !== undefined && (typeof password !== 'string' || password.length > 128))
          return new Response(null, { status: 400 })
        // The POST bridge keeps tokens and invitation callbacks out of request
        // URLs while retaining the library's rate limiter and JWT verifier.
        return await runtime.verifyEmail(configuration, {
          token: body.token,
          headers,
          prove: async (accountId) => {
            const resolution = await credentials.resolve(request, facts)
            if (resolution.kind === 'device-sign-in' && resolution.accountId === accountId)
              return true
            return (
              typeof password === 'string' && (await accounts.verifyPassword(accountId, password))
            )
          },
        })
      }
      if (path.startsWith('/reset-password/') || (path === '/reset-password' && incoming.search)) {
        return new Response(null, { status: 400 })
      }
      if (path === '/link-social') {
        const resolution = await credentials.resolve(request, facts)
        if (
          resolution.kind === 'device-sign-in' &&
          !(await accounts.isEmailVerified(resolution.accountId))
        ) {
          return Response.json(
            { message: 'Verify your email before linking a sign-in provider.' },
            { status: 403 },
          )
        }
      }
      const url = `${configuration.origin}${incoming.pathname}${incoming.search}`
      const hasBody = request.method !== 'GET' && request.method !== 'HEAD'
      const forwarded = new Request(url, {
        method: request.method,
        headers,
        ...(hasBody ? { body: await request.arrayBuffer() } : {}),
      })
      return await runtime.transaction(async () => {
        if (path === '/reset-password' && request.method === 'POST') {
          const body: unknown = await forwarded
            .clone()
            .json()
            .catch(() => null)
          if (
            body &&
            typeof body === 'object' &&
            'token' in body &&
            typeof body.token === 'string' &&
            body.token.length <= 128
          ) {
            const verification = await configuration.context.internalAdapter.findVerificationValue(
              `reset-password:${body.token}`,
            )
            if (verification && verification.expiresAt.getTime() > runtime.now().getTime()) {
              // Reset and password issuance take the same lock before writing.
              // A sign-in that proved the old hash must finish before reset,
              // or recheck the new hash after reset; it cannot survive between.
              await accountForAuthentication(runtime.db()).run({ id: verification.value })
            }
          }
        }
        return await configuration.auth.handler(forwarded)
      })
    }
  }
  return { core, runtime }
}
