/**
 * The core: the object the package builds from an edition configuration
 * (specification, section 2.3).
 */
import { accountOperations } from './accounts'
import { capabilitiesOf } from './capabilities'
import { oneTimeCodeOperations } from './codes'
import { credentialOperations } from './credentials'
import { deviceSignInOperations } from './device-sign-ins'
import { CLIENT_ADDRESS_HEADER, createRuntime, type Runtime } from './runtime'
import { signInOperations } from './sign-in'
import { deleteExpiredCodes } from './statements'
import { type IdentityConfig, type IdentityCore, IdentityRefused } from './types'

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

  const core: IdentityCore = {
    capabilities: () => capabilities,
    accounts: accountOperations(runtime),
    signIn: signInOperations(runtime, credentials),
    deviceSignIns,
    codes: oneTimeCodeOperations(runtime, deviceSignIns),
    credentials: { resolve: credentials.resolve, renew: credentials.renew },
    workspace() {
      // The workspace-bound half joins the membership onto the resolution
      // statement and applies memberships to member rows. It is built by the
      // memberships task (POD-6745) in src/membership.
      throw new IdentityRefused('not-built', 'identity: memberships are not built yet')
    },
    async sweep() {
      await deleteExpiredCodes(runtime.db()).run({ now: runtime.now() })
    },
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
      const url = `${configuration.origin}${incoming.pathname}${incoming.search}`
      const hasBody = request.method !== 'GET' && request.method !== 'HEAD'
      return await configuration.auth.handler(
        new Request(url, {
          method: request.method,
          headers,
          ...(hasBody ? { body: await request.arrayBuffer() } : {}),
        }),
      )
    }
  }
  return { core, runtime }
}
