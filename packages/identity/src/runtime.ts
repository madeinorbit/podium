/**
 * What every operation of one core shares: the database handle and the
 * transaction, the configurations of the sign-in library, and the one way the
 * package calls that library's request handler.
 *
 * Reference: docs/design/people-and-sign-in.md, sections 2.1 to 2.3.
 */
import { AsyncLocalStorage } from 'node:async_hooks'
import { runWithAdapter } from '@better-auth/core/context'
import { APIError } from '@better-auth/core/error'
import { drizzleAdapter } from '@better-auth/drizzle-adapter'
import type { BetterAuthOptions } from 'better-auth'
import { betterAuth } from 'better-auth/minimal'
import { bearer } from 'better-auth/plugins/bearer'
import { hashedSessionTokens, type LibraryAdapter } from './hashed-session-tokens'
import { accountMailLink } from './mail-links'
import { pgIdentityTables } from './schema/pg'
import { sqliteIdentityTables } from './schema/sqlite'
import { signToken } from './secrets'
import {
  accountForAuthentication,
  deletePasswordMethod,
  deleteSignInsOfAccount,
  type IdentityTables,
  passwordOfAccount,
  registerHandle,
  signInById,
  unverifiedPasswordAccount,
} from './statements'
import type { ConnectionFacts, DeviceDescription, IdentityConfig } from './types'

const DAY_SECONDS = 86_400
/** Device sign-ins last 30 days and are renewed at most once a day. */
export const SIGN_IN_LIFE_SECONDS = 30 * DAY_SECONDS
export const RENEW_AFTER_SECONDS = DAY_SECONDS

/**
 * The one header the library reads a client address from. The package writes
 * it from the connection facts on a request it builds itself, so a caller
 * cannot choose its own throttling key.
 */
export const CLIENT_ADDRESS_HEADER = 'x-podium-client-address'

/** The library routes that cannot work on hashed tokens; the package's device operations replace them. */
const DISABLED_LIBRARY_PATHS = [
  '/list-sessions',
  '/revoke-session',
  '/revoke-sessions',
  '/revoke-other-sessions',
]

type Auth = ReturnType<typeof betterAuth>
type AuthContext = Awaited<Auth['$context']>

/** One configuration of the library: the same database and secret, one cookie. */
export interface Configuration {
  readonly name: 'secure' | 'loopback' | 'fixed'
  readonly auth: Auth
  readonly context: AuthContext
  /** The fixed address the package's own requests to the library use. */
  readonly origin: string
  readonly basePath: string
  readonly cookie: {
    readonly name: string
    readonly secure: boolean
    readonly domain: string | undefined
  }
}

/** What a device sign-in made during a library call must carry, and what was made. */
interface DeviceScope {
  readonly device: DeviceDescription
  created?: { id: string; accountId: string; expiresAt: Date }
}

/**
 * What the library's own password hashing writes: a 16-byte salt and a 64-byte
 * scrypt key, both in hex, joined by a colon. The shared suite hashes a
 * password with the library and hands the result to `setPasswordHash`, so a
 * library that changed its format fails there.
 */
const LIBRARY_PASSWORD_HASH = /^[0-9a-f]{32}:[0-9a-f]{128}$/

export interface Runtime {
  readonly config: IdentityConfig
  now(): Date
  /** The handle statements must use now: the open transaction's, or the root. */
  db(): object
  /** Runs fn in one transaction of the database port, joining one that is open. */
  transaction<T>(fn: () => Promise<T>): Promise<T>
  /** True while a transaction of the database port is open around the caller. */
  inTransaction(): boolean
  /** The configuration these facts select, or undefined: plain HTTP that is not same-machine. */
  configurationFor(facts: ConnectionFacts): Configuration | undefined
  readonly configurations: readonly Configuration[]
  /** Any configuration's library context; they share the database. */
  readonly library: AuthContext
  /**
   * Calls the library's request handler with a request the package builds: the
   * configuration's own fixed address as URL and Origin, only the named caller
   * headers, and the client address from the facts.
   */
  callLibrary(
    configuration: Configuration,
    call: {
      method: 'GET' | 'POST'
      path: string
      facts: ConnectionFacts
      caller?: Headers
      body?: unknown
      device?: DeviceDescription
    },
  ): Promise<{ response: Response; created: DeviceScope['created'] }>
  /** Verifies a mailed token only after proving the account it names, under its lock. */
  verifyEmail(
    configuration: Configuration,
    input: { token: string; headers: Headers; prove: (accountId: string) => Promise<boolean> },
  ): Promise<Response>
  /** A Set-Cookie value that carries this token under the configuration's cookie. */
  sessionCookie(configuration: Configuration, token: string, expiresAt: Date): string
  hashPassword(password: string): Promise<string>
  verifyPassword(password: string, hash: string): Promise<boolean>
  /** Is this string in the format `hashPassword` writes in this edition? */
  isPasswordHash(value: string): boolean
  newId(model: string): string
  /** Listeners for a change of an account's name, picture or email (memberships subscribe). */
  readonly accountChanged: Array<(accountId: string) => Promise<void>>
  /**
   * With `accounts: 'local'`, may this account sign in? Set by the memberships
   * module: only an account with an active membership may. Undefined with
   * `accounts: 'shared'`, where an account outlives its memberships.
   */
  signInGate: ((accountId: string) => Promise<boolean>) | undefined
}

/** Headers of the caller that reach the library; nothing a caller can use to choose a host. */
const FORWARDED_CALLER_HEADERS = ['cookie', 'authorization', 'user-agent', 'content-type']

export async function createRuntime(config: IdentityConfig): Promise<Runtime> {
  const { dialect } = config.database
  const root = config.database.db as object
  const tables: IdentityTables = dialect === 'sqlite' ? sqliteIdentityTables : pgIdentityTables
  registerHandle(root, tables, dialect)
  const now = config.now ?? (() => new Date())

  // ---- the transaction -----------------------------------------------------

  const scope = new AsyncLocalStorage<{ db: object }>()
  const deviceScope = new AsyncLocalStorage<DeviceScope>()
  const verificationScope = new AsyncLocalStorage<{
    token: string
    prove: (accountId: string) => Promise<boolean>
  }>()
  let adapterOptions: BetterAuthOptions | undefined
  const transactionAdapters = new WeakMap<object, LibraryAdapter>()

  const baseAdapter = (db: object) =>
    drizzleAdapter(db as never, {
      provider: dialect === 'sqlite' ? 'sqlite' : 'pg',
      schema: {
        user: tables.user,
        account: tables.account,
        session: tables.session,
        verification: tables.verification,
        ...('rateLimit' in tables ? { rateLimit: tables.rateLimit } : {}),
        // The tables of the edition's extensions; the package's own win.
        ...Object.fromEntries(
          Object.entries(config.libraryRoutes?.tables ?? {}).filter(
            ([model]) =>
              !['user', 'account', 'session', 'verification', 'rateLimit'].includes(model),
          ),
        ),
      },
      // The library's own transaction support is off; the hashing layer routes
      // its transaction call to the edition's runner.
      transaction: false,
    })

  /** The library's adapter bound to `db`, wrapped by the hashing layer. */
  const adapterFor = (db: object, options: BetterAuthOptions): LibraryAdapter =>
    // The adapter and the library each name the options type from their own
    // copy of the library's core; under stricter compiler settings (the cloud's)
    // the two do not unify, though they are the same shape.
    hashedSessionTokens(baseAdapter(db)(options as never), (callback) =>
      transaction(() => callback(adapterOfCurrentHandle(options))),
    )

  /** The adapter bound to one handle, made once per handle. */
  const adapterOfHandle = (db: object, options: BetterAuthOptions): LibraryAdapter => {
    let adapter = transactionAdapters.get(db)
    if (!adapter) {
      adapter = adapterFor(db, options)
      transactionAdapters.set(db, adapter)
    }
    return adapter
  }

  const adapterOfCurrentHandle = (options: BetterAuthOptions): LibraryAdapter =>
    adapterOfHandle(scope.getStore()?.db ?? root, options)

  async function transaction<T>(fn: () => Promise<T>): Promise<T> {
    if (scope.getStore()) return await fn()
    const port = config.database.transaction as (run: (db: object) => Promise<T>) => Promise<T>
    return await port(async (db) => {
      registerHandle(db, tables, dialect)
      const run = () => scope.run({ db }, fn)
      // On the server's store the transaction handle IS the root handle, and
      // the library's adapter already runs inside the transaction. On Postgres
      // the library must be told to use the adapter of this transaction.
      if (db === root || !adapterOptions) return await run()
      return (await runWithAdapter(adapterOfHandle(db, adapterOptions), run)) as T
    })
  }

  // ---- the library configurations -----------------------------------------

  const basePath = config.libraryRoutes?.basePath ?? '/identity'
  const providers = {
    ...(config.loginMethods.github ? { github: config.loginMethods.github } : {}),
    ...(config.loginMethods.google ? { google: config.loginMethods.google } : {}),
  }
  const mail = config.mail

  function options(variant: {
    baseURL: string
    trustedOrigins: string[]
    secure: boolean
    cookieDomain?: string
  }): BetterAuthOptions {
    return {
      baseURL: variant.baseURL,
      basePath,
      secret: config.secret,
      database: (libraryOptions: BetterAuthOptions) => {
        adapterOptions ??= libraryOptions
        // The library installs its adapter scope inside its request handler.
        // Follow our transaction at each call as well, so hooks and library
        // writes stay on the same handle when a ceremony holds an account lock.
        return new Proxy(adapterOfHandle(root, libraryOptions), {
          get(_target, property) {
            const adapter = adapterOfCurrentHandle(libraryOptions)
            const value = adapter[property]
            return typeof value === 'function' ? value.bind(adapter) : value
          },
        })
      },
      trustedOrigins: variant.trustedOrigins,
      emailAndPassword: {
        enabled: true,
        disableSignUp: !config.selfSignUp,
        requireEmailVerification: false,
        revokeSessionsOnPasswordReset: true,
        ...(config.passwordHashing ? { password: config.passwordHashing } : {}),
        ...(mail
          ? {
              onPasswordReset: async ({ user }) => {
                // A mailed reset proves the address and replaces the password;
                // unlike verification, no knowledge of the old password is needed.
                await runtime.library.internalAdapter.updateUser(user.id, { emailVerified: true })
              },
              sendResetPassword: async ({ user, url, token }) =>
                mail.send({
                  to: user.email,
                  subject: 'Reset your Podium password',
                  text: `Reset your password: ${accountMailLink(config.hosts.kind === 'fixed' ? config.hosts.appOrigin : variant.baseURL, 'reset-password', token, url)}`,
                }),
            }
          : {}),
      },
      ...(mail
        ? {
            emailVerification: {
              sendOnSignUp: true,
              autoSignInAfterVerification: false,
              beforeEmailVerification: async (user) => {
                const db = scope.getStore()?.db ?? root
                const [account] = await accountForAuthentication(db).run({ id: user.id })
                // The library has validated the JWT. Recheck the address after
                // taking the same lock as password changes and provider recovery.
                if (!account || account.email !== user.email)
                  throw new APIError('BAD_REQUEST', {
                    message: 'This verification link has expired.',
                  })
                if (!(await verificationScope.getStore()?.prove(user.id)))
                  throw new APIError('FORBIDDEN', {
                    code: 'verification_account_proof_required',
                    message: 'Enter this account’s password to verify its email.',
                  })
              },
              sendVerificationEmail: async ({ user, url, token }) =>
                mail.send({
                  to: user.email,
                  subject: 'Verify your Podium email',
                  text: `Confirm your email: ${accountMailLink(config.hosts.kind === 'fixed' ? config.hosts.appOrigin : variant.baseURL, 'verify-email', token, url)}`,
                }),
            },
          }
        : {}),
      socialProviders: providers,
      session: {
        expiresIn: SIGN_IN_LIFE_SECONDS,
        updateAge: RENEW_AFTER_SECONDS,
        cookieCache: { enabled: false },
        // Our columns on the device sign-in. A client can never set them.
        additionalFields: {
          deviceKind: { type: 'string', required: true, input: false },
          deviceName: { type: 'string', required: false, input: false },
          deviceId: { type: 'string', required: false, input: false },
          platform: { type: 'string', required: false, input: false },
          lastSeenAt: { type: 'date', required: false, input: false },
          fixedExpiry: { type: 'boolean', required: false, input: false },
        },
      },
      account: {
        // Both the local account and the provider must prove the same address.
        accountLinking: {
          enabled: Object.keys(providers).length > 0,
          requireLocalEmailVerified: true,
        },
        encryptOAuthTokens: true,
      },
      verification: { storeIdentifier: 'hashed' },
      rateLimit: {
        enabled: true,
        storage: config.rateLimit.storage,
        customRules: { '/verify-email': { window: 10, max: 3 } },
      },
      disabledPaths: DISABLED_LIBRARY_PATHS,
      advanced: {
        cookiePrefix: 'podium',
        useSecureCookies: variant.secure,
        ipAddress: { ipAddressHeaders: [CLIENT_ADDRESS_HEADER] },
        ...(config.generateId
          ? {
              database: {
                generateId: ({ model }: { model: string }) => config.generateId?.(model) ?? false,
              },
            }
          : {}),
        ...(variant.cookieDomain
          ? { crossSubDomainCookies: { enabled: true, domain: variant.cookieDomain } }
          : {}),
        defaultCookieAttributes: { secure: variant.secure, httpOnly: true, sameSite: 'lax' },
      },
      databaseHooks: {
        account: {
          create: {
            before: async (method) => {
              if (method.providerId === 'credential') return
              const db = scope.getStore()?.db ?? root
              const [account] = await accountForAuthentication(db).run({ id: method.userId })
              if (!account?.emailVerified)
                throw new APIError('FORBIDDEN', {
                  code: 'email_not_verified',
                  message: 'Verify your email before linking a sign-in provider.',
                })
            },
          },
          update: {
            before: async (_method, context) => {
              if (context?.path !== '/change-password') return
              const session = context.context.session
              if (!session) throw new APIError('UNAUTHORIZED', { message: 'Sign in again.' })
              const db = scope.getStore()?.db ?? root
              await accountForAuthentication(db).run({ id: session.user.id })
              const [live] = await signInById(db).run({ id: session.session.id, now: now() })
              if (!live || live.accountId !== session.user.id)
                throw new APIError('UNAUTHORIZED', { message: 'Sign in again.' })
            },
          },
        },
        session: {
          create: {
            // A sign-in the library makes during one of our calls carries the
            // device the caller described. One made by the library's own routes
            // (the cloud's provider sign-in) is a browser's.
            before: async (session, context) => {
              if (
                context?.path === '/sign-in/email' ||
                context?.path === '/sign-up/email' ||
                context?.path === '/change-password'
              ) {
                const db = scope.getStore()?.db ?? root
                await accountForAuthentication(db).run({ id: session.userId })
                const [password] = await passwordOfAccount(db).run({ accountId: session.userId })
                if (!password?.password)
                  throw new APIError('UNAUTHORIZED', { message: 'Sign in again.' })
                if (context?.path === '/sign-in/email') {
                  const submitted = context.body?.password
                  if (
                    typeof submitted !== 'string' ||
                    !(await runtime.verifyPassword(submitted, password.password))
                  ) {
                    throw new APIError('UNAUTHORIZED', { message: 'Sign in again.' })
                  }
                }
              }
              const device = deviceScope.getStore()?.device
              const given = session as Record<string, unknown>
              return {
                data: {
                  ...session,
                  deviceKind: device?.kind ?? given.deviceKind ?? 'browser',
                  deviceName: device?.name ?? given.deviceName ?? null,
                  deviceId: device?.deviceId ?? given.deviceId ?? null,
                  platform: device?.platform ?? given.platform ?? null,
                  fixedExpiry: given.fixedExpiry ?? false,
                },
              }
            },
            after: async (session) => {
              const store = deviceScope.getStore()
              if (store) {
                store.created = {
                  id: session.id,
                  accountId: session.userId,
                  expiresAt: session.expiresAt,
                }
              }
            },
          },
        },
        user: {
          update: {
            after: async (user) => {
              for (const listener of runtime.accountChanged) await listener(user.id)
            },
          },
        },
      },
      plugins: [
        ...(config.libraryRoutes?.extensions ?? []),
        // A token is accepted only in its signed form, so a copy of the
        // database holds nothing that signs anyone in.
        bearer({ requireSignature: true }),
      ],
    }
  }

  async function configure(
    name: Configuration['name'],
    variant: Parameters<typeof options>[0],
  ): Promise<Configuration> {
    const settings = options(variant)
    const configured: BetterAuthOptions = {
      ...settings,
      plugins: [
        ...(settings.plugins ?? []),
        {
          id: 'fragment-email-verification',
          // Run through the HTTP handler's rate limiter, then bridge the
          // token-free POST to the library's JWT verifier without a token URL.
          onRequest: async (request) => {
            if (
              request.method !== 'POST' ||
              new URL(request.url).pathname !== `${basePath}/verify-email`
            )
              return
            const ceremony = verificationScope.getStore()
            if (!ceremony) return { response: new Response(null, { status: 403 }) }
            return {
              response: await auth.api.verifyEmail({
                query: { token: ceremony.token },
                headers: request.headers,
                asResponse: true,
              }),
            }
          },
        },
      ],
    }
    const auth: Auth = betterAuth(configured)
    const context = await auth.$context
    if (config.accounts === 'shared') {
      for (const provider of context.socialProviders) {
        const getUserInfo = provider.getUserInfo.bind(provider)
        provider.getUserInfo = async (input) => {
          const profile = await getUserInfo(input)
          if (profile?.user.emailVerified !== true) return null
          // Only the provider's verified assertion can reclaim a pre-registration.
          // Keep the account and its data; revoke the unproved password and all
          // existing sessions before marking its address verified and linking.
          if (profile?.user.email && profile.user.emailVerified === true) {
            await transaction(async () => {
              const db = scope.getStore()?.db ?? root
              const [unverified] = await unverifiedPasswordAccount(db).run({
                email: profile.user.email!.toLowerCase(),
              })
              if (unverified) {
                await deletePasswordMethod(db).run({ accountId: unverified.id })
                await deleteSignInsOfAccount(db).run({ accountId: unverified.id })
                await context.internalAdapter.updateUser(unverified.id, {
                  emailVerified: true,
                  name: profile.user.name ?? 'Podium account',
                  image: profile.user.image ?? null,
                })
              }
            })
          }
          return profile
        }
      }
    }
    return {
      name,
      auth,
      context,
      origin: new URL(variant.baseURL).origin,
      basePath,
      cookie: {
        name: context.authCookies.sessionToken.name,
        secure: variant.secure,
        domain: variant.cookieDomain,
      },
    }
  }

  // For a self-hosted server the two configurations never see a real host: the
  // package builds every request to them itself, on these fixed addresses.
  const configurations: Configuration[] =
    config.hosts.kind === 'self-hosted'
      ? [
          await configure('secure', {
            baseURL: 'https://identity.podium.invalid',
            trustedOrigins: ['https://identity.podium.invalid'],
            secure: true,
          }),
          await configure('loopback', {
            baseURL: 'http://identity.podium.invalid',
            trustedOrigins: ['http://identity.podium.invalid'],
            secure: false,
          }),
        ]
      : [
          await configure('fixed', {
            baseURL: config.hosts.authUrl,
            trustedOrigins: [config.hosts.appOrigin],
            secure: true,
            cookieDomain: config.hosts.cookieDomain,
          }),
        ]

  function configurationFor(facts: ConnectionFacts): Configuration | undefined {
    if (config.hosts.kind === 'fixed') {
      return facts.scheme === 'https' ? configurations[0] : undefined
    }
    if (facts.scheme === 'https') return configurations[0]
    return facts.sameMachine ? configurations[1] : undefined
  }

  const library = (configurations[0] as Configuration).context

  const runtime: Runtime = {
    config,
    now,
    db: () => scope.getStore()?.db ?? root,
    transaction,
    inTransaction: () => scope.getStore() !== undefined,
    configurationFor,
    configurations,
    library,
    async verifyEmail(configuration, input) {
      const request = new Request(`${configuration.origin}${configuration.basePath}/verify-email`, {
        method: 'POST',
        headers: input.headers,
        body: JSON.stringify({ token: input.token }),
      })
      return await verificationScope.run(input, () =>
        transaction(() => configuration.auth.handler(request)),
      )
    },
    async callLibrary(configuration, call) {
      const headers = new Headers()
      for (const name of FORWARDED_CALLER_HEADERS) {
        const value = call.caller?.get(name)
        if (value) headers.set(name, value)
      }
      headers.set('origin', configuration.origin)
      if (call.facts.clientAddress) headers.set(CLIENT_ADDRESS_HEADER, call.facts.clientAddress)
      if (call.body !== undefined) headers.set('content-type', 'application/json')
      const request = new Request(`${configuration.origin}${configuration.basePath}${call.path}`, {
        method: call.method,
        headers,
        ...(call.body !== undefined ? { body: JSON.stringify(call.body) } : {}),
      })
      const store: DeviceScope = { device: call.device ?? { kind: 'browser' } }
      const response = await deviceScope.run(store, () =>
        transaction(() => configuration.auth.handler(request)),
      )
      return { response, created: store.created }
    },
    sessionCookie(configuration, token, expiresAt) {
      const maxAge = Math.max(0, Math.floor((expiresAt.getTime() - now().getTime()) / 1000))
      return [
        `${configuration.cookie.name}=${encodeURIComponent(signToken(token, config.secret))}`,
        `Max-Age=${maxAge}`,
        ...(configuration.cookie.domain ? [`Domain=${configuration.cookie.domain}`] : []),
        'Path=/',
        'HttpOnly',
        ...(configuration.cookie.secure ? ['Secure'] : []),
        'SameSite=Lax',
      ].join('; ')
    },
    hashPassword: (password) =>
      config.passwordHashing
        ? config.passwordHashing.hash(password)
        : library.password.hash(password),
    verifyPassword: (password, hash) =>
      config.passwordHashing
        ? config.passwordHashing.verify({ password, hash })
        : library.password.verify({ password, hash }),
    isPasswordHash: (value) =>
      config.passwordHashing
        ? (config.passwordHashing.isHash?.(value) ?? false)
        : LIBRARY_PASSWORD_HASH.test(value),
    newId(model) {
      const made = config.generateId?.(model)
      if (made) return made
      const generated = library.generateId({ model })
      return typeof generated === 'string' ? generated : crypto.randomUUID()
    },
    accountChanged: [],
    signInGate: undefined,
  }
  return runtime
}
