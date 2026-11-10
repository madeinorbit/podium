/**
 * Every public type of the shared identity package.
 *
 * The reference is docs/design/people-and-sign-in.md, section 2. Words: an
 * ACCOUNT is a person who can sign in, a LOGIN METHOD is a password or a
 * provider, a DEVICE SIGN-IN is one signed-in browser, app, phone or host
 * session, and a MEMBER is one person inside one workspace. The sign-in library
 * calls an account a "user" and a login method an "account"; those words appear
 * only in table and column names.
 */
import type { BetterAuthPlugin } from 'better-auth'
import type { PgAsyncDatabase } from 'drizzle-orm/pg-core'
import type { SQLiteAsyncDatabase } from 'drizzle-orm/sqlite-core'

// ---------------------------------------------------------------------------
// Edition configuration (section 2.1)
// ---------------------------------------------------------------------------

export interface IdentityConfig {
  database: IdentityDatabase
  /** Signs cookie and bearer values (section 1.7). */
  secret: string
  loginMethods: {
    password: true
    google?: { clientId: string; clientSecret: string }
    github?: { clientId: string; clientSecret: string }
  }
  /** Sends invitation, verification and reset mail. null: nothing is ever mailed. */
  mail: IdentityMailer | null
  /** May a person create an account without an invitation? */
  selfSignUp: boolean
  /**
   * 'local': accounts exist only for this database's memberships. They are made by
   * setup or by accepting an invitation, and end with the membership.
   * 'shared': accounts outlive memberships (the cloud).
   */
  accounts: 'local' | 'shared'
  hosts: HostPolicy
  /** null: the same-machine rule does not exist in this edition. */
  sameMachine: { waived: () => boolean | Promise<boolean> } | null
  /** Absent: the library's own password hashing. */
  passwordHashing?: {
    hash(password: string): Promise<string>
    verify(input: { password: string; hash: string }): Promise<boolean>
    /**
     * Is this string a hash `hash` could have made? `accounts.setPasswordHash`
     * accepts nothing else. Absent: an edition with its own hashing accepts no
     * ready-made hash at all.
     */
    isHash?(value: string): boolean
  }
  rateLimit: { storage: 'memory' | 'database' }
  /** Mounts the library's own HTTP routes at this path. Absent: they are not reachable. */
  libraryRoutes?: {
    basePath: string
    extensions?: LibraryExtension[]
    /**
     * The tables of the extensions, by the library's model name. An extension
     * with models of its own (the cloud's organisation extension: `organization`,
     * `member`, `invitation`) reads and writes them through the same adapter as
     * the library, so the edition that owns those tables hands them over here.
     */
    tables?: Record<string, object>
  }
  /** Absent: the library's ids. */
  generateId?: (model: string) => string
  /**
   * Mints the id of a new member, which is the id of its member row (`users.id`).
   * The member row belongs to the server, so the server says how its ids look.
   */
  newMemberId: () => string
  /**
   * The link an invitee opens, for an edition that mails invitations. Absent:
   * no invitation is mailed and the admin copies the link the route builds.
   */
  invitationUrl?: (token: string, workspaceId: string) => string
  now?: () => Date
}

export type HostPolicy =
  /** Any host over HTTPS, and plain HTTP only on a same-machine connection. Cookies are host-only. */
  | { kind: 'self-hosted' }
  /** One sign-in origin and a cookie shared by its subdomains. */
  | { kind: 'fixed'; authUrl: string; appOrigin: string; cookieDomain: string }

export interface IdentityMailer {
  send(message: { to: string; subject: string; text: string }): Promise<void>
}

/** An extension of the sign-in library, such as its organisation extension. */
export type LibraryExtension = BetterAuthPlugin

// ---------------------------------------------------------------------------
// The database port (section 2.2)
// ---------------------------------------------------------------------------

/**
 * The server's store handle. `transaction` is left out on purpose: the store's
 * executor does not know a span opened by drizzle, so every transaction goes
 * through the port.
 */
// biome-ignore lint/suspicious/noExplicitAny: the run result and relations differ per driver and are never read
export type SqliteDb = Omit<SQLiteAsyncDatabase<'async', any, any>, 'transaction'>
// biome-ignore lint/suspicious/noExplicitAny: the query result kind and relations differ per driver and are never read
export type PgDb = Omit<PgAsyncDatabase<any, any>, 'transaction'>

export type IdentityDatabase =
  | { dialect: 'sqlite'; db: SqliteDb; transaction: TransactionPort<SqliteDb> }
  | { dialect: 'pg'; db: PgDb; transaction: TransactionPort<PgDb> }

/** Runs fn in one transaction and hands it the handle its statements must use. */
export type TransactionPort<Db> = <T>(fn: (db: Db) => Promise<T>) => Promise<T>

// ---------------------------------------------------------------------------
// The core (section 2.3)
// ---------------------------------------------------------------------------

export interface IdentityCore {
  capabilities(): Capabilities
  accounts: AccountOperations
  signIn: SignInOperations
  deviceSignIns: DeviceSignInOperations
  codes: OneTimeCodeOperations
  /**
   * The half of `resolve` that needs no membership: from a request to the
   * device sign-in and account its credential names. The workspace-bound
   * `resolve` joins the membership onto the same statement.
   */
  credentials: CredentialOperations
  /** The workspace-bound half. A server process holds exactly one. */
  workspace(id: string, members: MemberRowsBinding): WorkspaceIdentity
  /** Present when `libraryRoutes` is configured: the library's own HTTP handler. */
  libraryHandler?: (request: Request, facts: ConnectionFacts) => Promise<Response>
  /** Deletes expired invitations and one-time codes. Called by the server on a timer, hourly. */
  sweep(): Promise<void>
  /**
   * Runs fn in one transaction of the database port. Every operation of this
   * core called inside joins it, and so do the edition's own statements when
   * they use the handle its port was given. For a rule of the edition that must
   * commit together with a membership: the cloud creates a workspace and its
   * creator's membership this way. A membership changed inside is applied to
   * member rows in another database by the next catch-up, not before fn returns.
   */
  transaction<T>(fn: () => Promise<T>): Promise<T>
}

export interface WorkspaceIdentity {
  readonly workspaceId: string
  readonly core: IdentityCore
  resolve(request: Request, facts: ConnectionFacts): Promise<Resolution>
  revalidate(held: HeldSignIn): Promise<boolean>
  renew(request: Request, facts: ConnectionFacts): Promise<Headers>
  signInRequired(): Promise<boolean>
  memberships: MembershipOperations
  listDeviceSignIns(page: { limit: number }): Promise<{ signIns: DeviceSignIn[]; total: number }>
  /** Hosted only: apply every membership change this workspace has not applied yet (section 11). */
  catchUp(): Promise<{ applied: number }>
}

/**
 * Three facts about a request, worked out by the server at its existing trust
 * boundary. The package never reads `Host`, `Forwarded` or any `X-Forwarded-*`
 * header.
 */
export interface ConnectionFacts {
  /** 'https': the server ended TLS itself, or the trusted proxy hop reported https. */
  scheme: 'https' | 'http'
  /** The peer is this machine: loopback peer address, loopback host, no proxy hop. */
  sameMachine: boolean
  /** The client's address for throttling: the peer, or the trusted hop's value. null: unknown. */
  clientAddress: string | null
}

// ---------------------------------------------------------------------------
// Accounts and sign-in (section 2.4)
// ---------------------------------------------------------------------------

export interface AccountOperations {
  /** Server-side creation; self sign-up plays no part. Email absent: a generated identifier (section 7). */
  create(input: {
    name: string
    email?: string
    password?: string
    passwordHash?: string
  }): Promise<Account>
  get(accountId: string): Promise<Account | undefined>
  byEmail(email: string): Promise<Account | undefined>
  hasPassword(accountId: string): Promise<boolean>
  verifyPassword(accountId: string, password: string): Promise<boolean>
  /** Replaces or creates the password login method. Does not end device sign-ins. */
  setPassword(accountId: string, password: string): Promise<void>
  /**
   * The same, from a hash the edition's own password functions made: a password
   * staged before the server ran, or one hashed before the caller's transaction.
   * Refused with `password-hash-invalid` for a string that is not in the
   * edition's own hash format, so a password in clear can never be stored by
   * mistake. FOR SERVER CODE ONLY: the hash must never come from a request body.
   */
  setPasswordHash(accountId: string, passwordHash: string): Promise<void>
  /** Changes the identifier. Refused when another account holds it. */
  setEmail(accountId: string, email: string): Promise<void>
  updateProfile(accountId: string, profile: { name?: string; image?: string | null }): Promise<void>
}

export interface Account {
  id: string
  name: string
  /** null when the identifier is generated. */
  email: string | null
  image: string | null
}

export interface SignInOperations {
  /** How the sign-in screen must ask (section 7). */
  prompt(): Promise<'password' | 'email-password'>
  password(
    input: {
      email?: string
      password: string
      device: DeviceDescription
      delivery: 'cookie' | 'bearer'
    },
    facts: ConnectionFacts,
  ): Promise<IssuedSignIn | SignInRefusal>
  signOut(
    request: Request,
    facts: ConnectionFacts,
  ): Promise<{ deviceSignInId: string | null; headers: Headers }>
}

export type SignInRefusal =
  /** Wrong identifier, wrong password, no active membership. */
  | { refused: 'invalid' }
  | { refused: 'throttled'; retryAfterSeconds: number }
  | { refused: 'https_required' }

export interface IssuedSignIn {
  deviceSignInId: string
  accountId: string
  expiresAt: Date
  /** delivery 'cookie': the Set-Cookie headers to add to the response. */
  headers: Headers
  /** delivery 'bearer': the signed token, shown once. */
  bearer: string | null
}

export type DeviceKind = 'browser' | 'desktop' | 'phone' | 'host'

export interface DeviceDescription {
  kind: DeviceKind
  name?: string
  deviceId?: string
  platform?: string
}

// ---------------------------------------------------------------------------
// From a request to a member (section 2.5)
// ---------------------------------------------------------------------------

/** What a request's credential names, before any membership is consulted. */
export type CredentialResolution =
  | {
      kind: 'device-sign-in'
      accountId: string
      deviceSignIn: { id: string; kind: DeviceKind; expiresAt: Date }
      /** The sign-in is due for its daily renewal. */
      renewDue: boolean
    }
  | { kind: 'unauthenticated' }
  | { kind: 'https_required' }

export interface CredentialOperations {
  /** One statement of the package; never calls the library. */
  resolve(request: Request, facts: ConnectionFacts): Promise<CredentialResolution>
  /**
   * Extends a sign-in that is due and returns the cookie to set. A sign-in with
   * a fixed expiry is never handed to the library.
   */
  renew(request: Request, facts: ConnectionFacts): Promise<Headers>
}

export type Resolution =
  | {
      kind: 'member'
      memberId: string
      role: 'admin' | 'member'
      accountId: string
      /** null: admitted by the same-machine rule; no device signed in. */
      deviceSignIn: { id: string; kind: DeviceKind; expiresAt: Date } | null
      /** The sign-in is due for its daily renewal; call renew() where a response can carry a cookie. */
      renewDue: boolean
    }
  | {
      kind: 'not-a-member'
      accountId: string
      membership: 'none' | 'invited' | 'disabled' | 'removed'
    }
  | { kind: 'unauthenticated' }
  | { kind: 'https_required' }

export type HeldSignIn =
  | { deviceSignInId: string; memberId: string; role: 'admin' | 'member' }
  | { sameMachine: true; memberId: string; role: 'admin' | 'member' }

// ---------------------------------------------------------------------------
// Memberships (section 2.6). Built in src/membership.
// ---------------------------------------------------------------------------

export interface MembershipOperations {
  list(): Promise<MembershipView[]>
  adopt(input: {
    by: 'setup' | 'organisation' | 'upgrade'
    memberId?: string
    role: 'admin' | 'member'
    status: 'invited' | 'active' | 'disabled'
    account: AccountRef | null
  }): Promise<MembershipView>
  invite(input: {
    actor: Actor
    role: 'admin' | 'member'
    email?: string
    memberId?: string
    expiresInDays?: number
  }): Promise<{ membership: MembershipView; invitation: IssuedInvitation; mailed: boolean }>
  revokeInvitation(input: { actor: Actor; invitationId: string }): Promise<void>
  inspectInvitation(
    token: string,
  ): Promise<{ email: string | null; expiresAt: Date; needsAccount: boolean }>
  accept(input: {
    token: string
    account: AccountRef
  }): Promise<{ memberId: string; accountId: string }>
  setRole(input: { actor: Actor; memberId: string; role: 'admin' | 'member' }): Promise<void>
  disable(input: { actor: Actor; memberId: string }): Promise<void>
  enable(input: { actor: Actor; memberId: string }): Promise<void>
  remove(input: { actor: Actor; memberId: string }): Promise<void>
  endForAccount(input: {
    accountId: string
    workspaceIds: string[] | 'all'
    by: 'organisation' | 'account-deleted'
  }): Promise<void>
  /**
   * The account of a member whose membership here is active. One statement by
   * primary key. For the sign-in carry-over (POD-6751), which builds it.
   */
  accountOfActiveMember(memberId: string): Promise<string | undefined>
}

export type Actor = { memberId: string } | { system: 'host' | 'setup' | 'organisation' | 'upgrade' }

export type AccountRef =
  | { kind: 'existing'; accountId: string }
  | { kind: 'new'; name: string; email?: string; password?: string; passwordHash?: string }

export interface IssuedInvitation {
  id: string
  token: string
  expiresAt: Date
}

export interface MembershipView {
  memberId: string
  role: 'admin' | 'member'
  status: 'invited' | 'active' | 'disabled' | 'removed'
  version: number
  account: Account | null
  invitedEmail: string | null
  hasPassword: boolean
  pendingInvitation: { id: string; expiresAt: Date } | null
}

export interface MembershipSnapshot {
  memberId: string
  version: number
  status: 'invited' | 'active' | 'disabled' | 'removed'
  role: 'admin' | 'member'
  accountId: string | null
  profile: { name: string; image: string | null; email: string | null } | null
  actor: Actor
}

/** Implemented by the server over its users repository. Nothing else may call write(). */
export interface MemberRows {
  write(change: MemberWrite): Promise<void>
  /**
   * Whether a member row with this id exists, in any state. An invitation may
   * name a member that has no membership yet only when its row exists (a
   * move). Absent: such an invitation is refused.
   */
  exists?(memberId: string): Promise<boolean>
}

export interface MemberWrite {
  memberId: string
  version: number
  state: 'active' | 'disabled' | 'removed'
  role: 'admin' | 'member'
  accountId: string | null
  profile: { name: string; image: string | null; email: string | null } | null
  actor: Actor
}

export type MemberRowsBinding =
  /** Member rows are in the membership database: apply inside the membership transaction. */
  | { rows: MemberRows; sameDatabase: true }
  /** Member rows are elsewhere: apply after the commit, through catchUp (section 11). */
  | { rows: MemberRows; sameDatabase: false; cursor: AppliedCursor }

export interface AppliedCursor {
  read(): Promise<number>
  write(version: number): Promise<void>
}

// ---------------------------------------------------------------------------
// Device sign-ins (section 2.7)
// ---------------------------------------------------------------------------

export interface DeviceSignInOperations {
  listForAccount(accountId: string, current?: string): Promise<DeviceSignIn[]>
  /**
   * Ends one sign-in. byAccount: only when it belongs to that account.
   * Without the guard it is an admin's act; a route may call it so only when
   * the capability adminEndDeviceSignIn is true.
   */
  revoke(
    id: string,
    guard?: { byAccount: string },
  ): Promise<{ revoked: boolean; accountId: string | null }>
  /** Ends every sign-in of the account but `except`, and answers the ids ended. */
  revokeAllForAccount(accountId: string, except?: string): Promise<string[]>
  /** Used by code redemption and by tests. Never reachable from a request without a code or a password. */
  create(
    accountId: string,
    device: DeviceDescription,
    delivery: 'cookie' | 'bearer',
    facts: ConnectionFacts,
    life?: { expiresAt: Date; fixed: boolean },
  ): Promise<IssuedSignIn>
}

export interface DeviceSignIn {
  id: string
  accountId: string
  kind: DeviceKind
  deviceName: string
  platform: string
  createdAt: Date
  lastSeenAt: Date | null
  expiresAt: Date
  current: boolean
}

// ---------------------------------------------------------------------------
// One-time codes (section 2.8)
// ---------------------------------------------------------------------------

export type CodePurpose =
  | 'pair-device'
  | 'hand-over'
  | 'password-reset'
  | 'host-sign-in'
  | 'transfer-claim'

export interface OneTimeCodeOperations {
  /** A code for an account, made by that account's signed-in device, by an admin, or by the host. */
  issue(input: {
    purpose: 'pair-device' | 'password-reset' | 'host-sign-in' | 'transfer-claim'
    accountId: string
    createdBy: string
    ttlMs?: number
    signInLife?: { ttlMs: number; fixed: boolean }
  }): Promise<{ id: string; code: string; expiresAt: Date }>

  /**
   * pair-device: the receiving device presents the code and binds its own verifier.
   * `phrase` names the claim in three words; the caller passes the function its
   * clients share, and without one the package derives its own.
   */
  claim(input: {
    code: string
    challenge: string
    device: DeviceDescription
    delivery: 'cookie' | 'bearer'
    phrase?: (claimId: string, challenge: string) => [string, string, string]
  }): Promise<{ claimId: string; phrase: [string, string, string]; expiresAt: Date } | undefined>
  status(id: string, accountId: string): Promise<CodeStatus>
  decide(id: string, accountId: string, decision: 'approved' | 'denied'): Promise<boolean>

  /** hand-over: the receiving device starts the attempt; a signed-in account authorises it. */
  begin(input: {
    purpose: 'hand-over'
    challenge: string
  }): Promise<{ id: string; expiresAt: Date }>
  authorise(input: {
    challenge: string
    accountId: string
    sourceSignInId: string
  }): Promise<{ code: string; expiresAt: Date } | 'ended' | undefined>

  /** Turns a code into a device sign-in. Atomic; a code works once. */
  redeem(
    input: { code: string; verifier?: string } | { claimId: string; verifier: string },
    device: DeviceDescription,
    delivery: 'cookie' | 'bearer',
    facts: ConnectionFacts,
  ): Promise<IssuedSignIn | 'pending' | undefined>

  inspectPasswordReset(code: string): Promise<{ email: string | null; expiresAt: Date } | undefined>
  redeemPasswordReset(input: {
    code: string
    password: string
  }): Promise<{ accountId: string; endedSignInIds: string[] } | undefined>
}

/** Where a pairing attempt stands, for the signed-in device that polls it. */
export type CodeStatus =
  /** Issued; no device has claimed it. */
  | { state: 'pending'; expiresAt: Date }
  /** A device claimed it and waits for the decision. */
  | {
      state: 'claimed'
      expiresAt: Date
      device: DeviceDescription
      phrase: [string, string, string]
    }
  | {
      state: 'approved'
      expiresAt: Date
      device: DeviceDescription
      phrase: [string, string, string]
    }
  | { state: 'denied' }
  /** Redeemed: the device is signed in. */
  | { state: 'completed' }
  /** Expired, unknown, or another account's. */
  | { state: 'expired' }

// ---------------------------------------------------------------------------
// The capability list (section 2.9)
// ---------------------------------------------------------------------------

export interface Capabilities {
  version: 1
  /** A password form is offered. */
  passwordSignIn: boolean
  /** The provider buttons to show. */
  providers: Array<'google' | 'github'>
  /** A person may create an account without an invitation. */
  selfSignUp: boolean
  /** 'link': the admin copies a link. 'mail': the server mails the invitee. */
  invitationDelivery: 'link' | 'mail'
  /** 'admin-link': an admin or the host issues a link. 'mail': the person asks for a mail. */
  passwordReset: 'admin-link' | 'mail'
  emailVerification: boolean
  organisations: boolean
  /** A one-person server may waive sign-in on its own machine. */
  sameMachineSignIn: boolean
  /** An admin may end every device sign-in of another member. */
  adminSignOutEverywhere: boolean
  /** An admin may end one device sign-in of another member. */
  adminEndDeviceSignIn: boolean
  /** Where a person signs in and manages their account when that is not this server. */
  accountUrl: string | null
}

// ---------------------------------------------------------------------------
// Refusals
// ---------------------------------------------------------------------------

/** An operation the package refuses; `code` says why. */
export class IdentityRefused extends Error {
  constructor(
    readonly code:
      | 'https_required'
      | 'email-taken'
      | 'email-invalid'
      | 'unknown-account'
      | 'password-hash-invalid'
      | 'not-built',
    message?: string,
  ) {
    super(message ?? code)
    this.name = 'IdentityRefused'
  }
}

export class MembershipRefused extends Error {
  constructor(
    readonly code:
      | 'admin-required'
      | 'last-admin'
      | 'self'
      | 'unavailable'
      | 'invitation-invalid'
      | 'already-a-member'
      | 'email-mismatch'
      | 'not-allowed',
    message?: string,
  ) {
    super(message ?? code)
    this.name = 'MembershipRefused'
  }
}
