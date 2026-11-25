/**
 * An unexpected failure answers with a generic sentence and a log reference; a
 * refusal written for the caller keeps its words and its code (POD-7617).
 *
 * A procedure that throws a plain error becomes tRPC's `INTERNAL_SERVER_ERROR`,
 * whose message tRPC copies from the thrown error: for a store failure that is
 * Drizzle's `Failed query: <statement> params: <values>`. The wire is checked
 * through tRPC's own HTTP handler with the server's real `t` and its failure
 * log, loaded the way the packaged binary loads it.
 */

import { asUserId, type CredentialId } from '@podium/model'
import { TRPCError } from '@trpc/server'
import { fetchRequestHandler } from '@trpc/server/adapters/fetch'
import { DrizzleQueryError } from 'drizzle-orm'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import { failureForClient, failureTextLogged, typedRefusal } from './client-error-diagnostics'
import { CloudRuntimeUserError } from './cloud-runtime'
import { MemberHasNoAccount } from './identity/member-credentials'
import { LlmConfigError } from './llm-error'
import { AgentProfileRefusal } from './modules/agent-profiles/service'
import { AutomationRefusal } from './modules/automations/service'
import { ConcertmasterRefusal } from './modules/concertmaster/service'
import { LoopbackUnavailable } from './modules/credentials/chatgpt-plan/service'
import { CredentialRefError } from './modules/credentials/credential-ref'
import { SignInRefused } from './modules/credentials/sign-in'
import { SecretUnavailableError, VaultLockedError } from './modules/credentials/vault'
import { IssueNotFound } from './modules/issues/service/not-found'
import { IssueForbidden, IssueRefusal } from './modules/issues/service/refusal'
import { issueCommandFailure } from './modules/issues/work-effects'
import { RefusedSendError } from './modules/machines/refused-send'
import { ConversationNotFound } from './modules/memory/service'
import { MailRefusal } from './modules/messages/refusal'
import { HandoffRefusalError } from './modules/sessions/handoff/refusal'
import { SESSION_NOT_FOUND, SessionGateRefusal } from './modules/sessions/session-access'
import { errorOfRecord } from './modules/sessions/session-handoff-effect'
import { launchErrorOfRecord } from './modules/sessions/session-launch-effect'
import { SettingsPatchRefused } from './modules/settings/service'
import { ShippingAdmissionError, ShippingOrderAccessError } from './modules/shipping/service'
import { SuperagentRefusal } from './modules/superagent/refusal'
import { trpcErrorRefusal } from './modules/sync-write/family'
import { ReleaseApprovalRefusal } from './modules/updates/release-approval'
import { UsageAttributionUnavailable } from './modules/usage-summary'
import { WorkflowRefusal } from './modules/workflows/handlers/context'
import { soleMemberFor } from './sole-member'
import { CollectionRequestError } from './sync/collection-shapes'

const GENERIC =
  /^The server could not complete this request; the server log has the details \(reference: ([0-9a-f-]{36})\)$/

/** A store failure exactly as Drizzle throws it over a driver error. */
function driverFailure(): Error {
  return new DrizzleQueryError(
    'insert into "locks" ("name", "holder_label") values ($1, $2)',
    ['deploy', 'holder-secret-label'],
    new Error('UNIQUE constraint failed: locks.name'),
  )
}

interface WireError {
  message: string
  data: { code: string; httpStatus: number; reference?: string; causeChain?: string }
}

/**
 * One procedure that throws `thrown()`, served by tRPC's HTTP handler with the
 * server's own `t` (formatter and middleware) loaded in the given mode, and
 * the server's failure log over a captured logger.
 */
async function wireErrorOf(
  thrown: () => unknown,
  env: Record<string, string | undefined>,
): Promise<{ error: WireError; logged: Record<string, unknown>[] }> {
  vi.resetModules()
  for (const [key, value] of Object.entries(env)) vi.stubEnv(key, value)
  const { t, logProcedureFailure } = await import('./trpc')
  const router = t.router({
    fails: t.procedure.query(() => {
      throw thrown()
    }),
  })
  const logged: Record<string, unknown>[] = []
  const log = {
    info: (msg: string, fields?: Record<string, unknown>) => logged.push({ msg, ...fields }),
    warn: (msg: string, fields?: Record<string, unknown>) => logged.push({ msg, ...fields }),
  }
  const response = await fetchRequestHandler({
    endpoint: '/trpc',
    req: new Request('http://podium.test/trpc/fails'),
    router,
    createContext: () => ({}) as never,
    onError: ({ error, path, type }) => logProcedureFailure(log as never, { error, path, type }),
  })
  const body = (await response.json()) as { error: WireError }
  return { error: body.error, logged }
}

const PACKAGED = { PODIUM_APP_VERSION: '1.2.3', NODE_ENV: undefined }
const FROM_SOURCE = { PODIUM_APP_VERSION: undefined, NODE_ENV: 'test' }

afterEach(() => {
  vi.unstubAllEnvs()
  vi.resetModules()
})

describe('a store driver error reaching a client', () => {
  it('carries no SQL, no parameters and no driver text from a packaged server', async () => {
    const { error, logged } = await wireErrorOf(driverFailure, PACKAGED)

    expect(error.message).toMatch(GENERIC)
    expect(JSON.stringify(error)).not.toMatch(
      /insert into|locks|holder|UNIQUE|params|Failed query|DrizzleQueryError/,
    )
    expect(error.data.code).toBe('INTERNAL_SERVER_ERROR')
    expect(error.data.httpStatus).toBe(500)
    // The reference is in the shape, and is the one the log line carries
    // together with the whole error.
    const reference = GENERIC.exec(error.message)?.[1]
    expect(error.data.reference).toBe(reference)
    const line = logged.find((entry) => entry.msg === 'tRPC procedure failed')
    expect(line?.reference).toBe(reference)
    expect((line?.err as TRPCError).cause).toBeInstanceOf(DrizzleQueryError)
  })

  it('answers with the generic sentence from source too; the chain stays the detail', async () => {
    const { error } = await wireErrorOf(driverFailure, FROM_SOURCE)

    expect(error.message).toMatch(GENERIC)
    expect(error.data.causeChain).toContain('UNIQUE constraint failed: locks.name')
  })

  it('gives every failure its own reference', async () => {
    const first = await wireErrorOf(driverFailure, PACKAGED)
    const second = await wireErrorOf(driverFailure, PACKAGED)
    expect(first.error.data.reference).not.toBe(second.error.data.reference)
  })

  it('reaches an agent over the relay or MCP as the generic sentence', () => {
    const answer = failureForClient(driverFailure(), false)
    expect(answer.text).toMatch(GENERIC)
    expect(answer.text).toContain(`(reference: ${answer.reference})`)
  })
})

/** Each domain refusal class, the code it answers with, and its words. */
const BRANDED: ReadonlyArray<{ name: string; error: () => Error; code: TRPCError['code'] }> = [
  { name: 'IssueRefusal', error: () => new IssueRefusal('issue is closed'), code: 'CONFLICT' },
  {
    name: 'IssueForbidden',
    error: () => new IssueForbidden('not your comment'),
    code: 'FORBIDDEN',
  },
  { name: 'IssueNotFound', error: () => new IssueNotFound('POD-1'), code: 'NOT_FOUND' },
  {
    name: 'MailRefusal',
    error: () => new MailRefusal('target-not-found', 'unknown message m1'),
    code: 'NOT_FOUND',
  },
  {
    name: 'WorkflowRefusal',
    error: () => new WorkflowRefusal('invalid', 'workflow has no step s9'),
    code: 'BAD_REQUEST',
  },
  {
    name: 'AutomationRefusal',
    error: () => new AutomationRefusal('not-found', 'unknown automation: a1'),
    code: 'NOT_FOUND',
  },
  {
    name: 'ConcertmasterRefusal',
    error: () => new ConcertmasterRefusal('unauthorized', 'not served here'),
    code: 'FORBIDDEN',
  },
  {
    name: 'SuperagentRefusal',
    error: () => new SuperagentRefusal('conflict', 'the thread is open in a terminal'),
    code: 'CONFLICT',
  },
  {
    name: 'SessionGateRefusal (absent)',
    error: () => new SessionGateRefusal(SESSION_NOT_FOUND),
    code: 'NOT_FOUND',
  },
  {
    name: 'SessionGateRefusal (refused)',
    error: () => new SessionGateRefusal('outside your subtree'),
    code: 'FORBIDDEN',
  },
  {
    name: 'HandoffRefusalError',
    error: () => new HandoffRefusalError('target machine is offline', 'unreachable'),
    code: 'PRECONDITION_FAILED',
  },
  {
    name: 'SettingsPatchRefused',
    error: () => new SettingsPatchRefused('unknown preference'),
    code: 'BAD_REQUEST',
  },
  {
    name: 'AgentProfileRefusal',
    error: () => new AgentProfileRefusal('a profile named x already exists'),
    code: 'BAD_REQUEST',
  },
  {
    name: 'ShippingAdmissionError',
    error: () => new ShippingAdmissionError('blocked', 'the issue is blocked'),
    code: 'PRECONDITION_FAILED',
  },
  {
    name: 'ShippingOrderAccessError',
    error: () => new ShippingOrderAccessError(),
    code: 'NOT_FOUND',
  },
  {
    name: 'ReleaseApprovalRefusal',
    error: () => new ReleaseApprovalRefusal('the proposal moved'),
    code: 'PRECONDITION_FAILED',
  },
  {
    name: 'SignInRefused',
    error: () => new SignInRefused('no such sign-in', undefined, 'not-found'),
    code: 'NOT_FOUND',
  },
  {
    name: 'LoopbackUnavailable',
    error: () => new LoopbackUnavailable('paste the address instead'),
    code: 'BAD_REQUEST',
  },
  {
    name: 'VaultLockedError',
    error: () => new VaultLockedError('the vault is locked'),
    code: 'PRECONDITION_FAILED',
  },
  {
    name: 'SecretUnavailableError',
    error: () =>
      new SecretUnavailableError('cred_1' as CredentialId, 'revoked', 'the credential is revoked'),
    code: 'PRECONDITION_FAILED',
  },
  {
    name: 'CredentialRefError',
    error: () => new CredentialRefError('two credentials share that label'),
    code: 'PRECONDITION_FAILED',
  },
  {
    name: 'CollectionRequestError',
    error: () => new CollectionRequestError('unknown collection'),
    code: 'BAD_REQUEST',
  },
  { name: 'ConversationNotFound', error: () => new ConversationNotFound(), code: 'NOT_FOUND' },
  {
    name: 'MemberHasNoAccount',
    error: () => new MemberHasNoAccount(asUserId('u1')),
    code: 'PRECONDITION_FAILED',
  },
  {
    name: 'UsageAttributionUnavailable',
    error: () => new UsageAttributionUnavailable(),
    code: 'PRECONDITION_FAILED',
  },
  {
    name: 'LlmConfigError',
    error: () => new LlmConfigError('no model is configured'),
    code: 'PRECONDITION_FAILED',
  },
  {
    name: 'RefusedSendError',
    error: () => new RefusedSendError('no daemon is connected to m1'),
    code: 'SERVICE_UNAVAILABLE',
  },
  {
    name: 'CloudRuntimeUserError',
    error: () => new CloudRuntimeUserError('FORBIDDEN', 'grant the repository first'),
    code: 'FORBIDDEN',
  },
]

describe('a domain refusal thrown plainly from a procedure', () => {
  it.each(BRANDED)('$name answers $code in its own words', async ({ error, code }) => {
    const { error: wire, logged } = await wireErrorOf(error, PACKAGED)

    expect(wire.message).toBe(error().message)
    expect(wire.data.code).toBe(code)
    expect(wire.data).not.toHaveProperty('reference')
    expect(logged.find((entry) => entry.msg === 'tRPC procedure failed')).not.toHaveProperty(
      'reference',
    )
  })

  it.each(BRANDED)('$name reaches an agent in its own words', ({ error }) => {
    const answer = failureForClient(error(), false)
    expect(answer).toEqual({ text: error().message })
  })
})

describe("a schema's own ZodError", () => {
  function zodError(): Error {
    const parsed = z.object({ id: z.string() }).safeParse({})
    if (parsed.success) throw new Error('unreachable')
    return parsed.error
  }

  it('reaches an agent as the list of what its input got wrong', () => {
    expect(failureForClient(zodError(), false)).toEqual({ text: zodError().message })
  })

  it('stays a fault inside a procedure, whose input tRPC already validated', async () => {
    const { error } = await wireErrorOf(zodError, PACKAGED)
    expect(error.message).toMatch(GENERIC)
    expect(error.data.code).toBe('INTERNAL_SERVER_ERROR')
  })

  it('is recorded as a fault by an issue command effect', () => {
    expect(issueCommandFailure(zodError())).toMatchObject({ error: { code: 'failed' } })
  })
})

describe('a wrapper that keeps a failure as text (POD-7617)', () => {
  it("keeps a refusal's words and logs nothing", () => {
    const warned: unknown[] = []
    const text = failureTextLogged(new IssueRefusal('issue is closed'), {
      warn: (...args: unknown[]) => warned.push(args),
    })
    expect(text).toBe('issue is closed')
    expect(warned).toEqual([])
  })

  it('answers a fault with the generic sentence and logs it under that reference', () => {
    const warned: Array<[string, Record<string, unknown>]> = []
    const text = failureTextLogged(
      driverFailure(),
      { warn: (msg: string, fields?: Record<string, unknown>) => warned.push([msg, fields ?? {}]) },
      'spawn on wake failed',
      false,
    )
    expect(text).toMatch(GENERIC)
    expect(warned).toHaveLength(1)
    expect(text).toContain(`(reference: ${String(warned[0]?.[1].reference)})`)
    expect(warned[0]?.[1].err).toBeInstanceOf(DrizzleQueryError)
  })

  it('passes a typed refusal on and leaves a fault for the transports', () => {
    expect(typedRefusal(new MailRefusal('conflict', 'already replied'))).toMatchObject({
      code: 'CONFLICT',
      message: 'already replied',
    })
    expect(typedRefusal(new TRPCError({ code: 'BAD_REQUEST', message: 'bad path' }))?.message).toBe(
      'bad path',
    )
    expect(typedRefusal(driverFailure())).toBeUndefined()
    expect(
      typedRefusal(new TRPCError({ code: 'INTERNAL_SERVER_ERROR', cause: driverFailure() })),
    ).toBeUndefined()
  })
})

describe('a refusal that clears on its own (POD-7617)', () => {
  it('is not a definitive sync refusal, so the outbox retries it', () => {
    const offline = typedRefusal(new RefusedSendError('no daemon is connected to m1'))
    expect(offline?.code).toBe('SERVICE_UNAVAILABLE')
    expect(trpcErrorRefusal(offline)).toBeUndefined()
    // A state a person must change stays definitive.
    expect(
      trpcErrorRefusal(new TRPCError({ code: 'CONFLICT', message: 'issue is closed' })),
    ).toEqual({ kind: 'conflict', message: 'issue is closed' })
  })
})

describe('a refusal a converted call site throws (POD-7617)', () => {
  it('keeps its message and code', async () => {
    const twoMembers = { soleActiveMember: async () => undefined }
    const refused = await soleMemberFor(twoMembers, 'a session start').catch((e: unknown) => e)
    expect(refused).toBeInstanceOf(TRPCError)
    expect(refused).toMatchObject({
      code: 'PRECONDITION_FAILED',
      message: 'a session start names no owner, and this instance has more than one member',
    })
  })
})

describe('a failure an effect record carries back to its caller', () => {
  it('rebuilds a handoff refusal as one and a fault as a fault', () => {
    const refusal = errorOfRecord({
      error: { code: 'refused', message: 'session is already on that machine' },
    })
    expect(refusal).toMatchObject({
      code: 'PRECONDITION_FAILED',
      message: 'session is already on that machine',
    })
    const classified = errorOfRecord({
      error: { code: 'unreachable', message: 'target machine is offline' },
    })
    expect(classified).toBeInstanceOf(HandoffRefusalError)
    const fault = errorOfRecord({ error: { code: 'failed', message: 'Failed query: select 1' } })
    expect(fault).not.toBeInstanceOf(TRPCError)
    expect(failureForClient(fault, false).text).toMatch(GENERIC)
  })

  it('rebuilds a launch record by its code when the run error is not in this process', () => {
    expect(
      launchErrorOfRecord(
        { error: { code: 'refused', message: 'file attachments need a first prompt' } },
        'the session could not start',
      ),
    ).toMatchObject({
      code: 'PRECONDITION_FAILED',
      message: 'file attachments need a first prompt',
    })
    const fault = launchErrorOfRecord(
      { error: { code: 'failed', message: 'Failed query: insert into "sessions"' } },
      'the session could not start',
    )
    expect(failureForClient(fault, false).text).toMatch(GENERIC)
  })

  it('records an issue command refusal with its code, and a wrapped fault as a fault', () => {
    expect(issueCommandFailure(new MailRefusal('target-not-found', 'unknown message m1'))).toEqual({
      status: 'failed',
      error: { code: 'NOT_FOUND', message: 'unknown message m1' },
    })
    const wrapped = new TRPCError({ code: 'INTERNAL_SERVER_ERROR', cause: driverFailure() })
    expect(issueCommandFailure(wrapped)).toMatchObject({ error: { code: 'failed' } })
  })
})
