/**
 * The surfaces a store failure passes through on its way to a human
 * [POD-3805, POD-3802 §2].
 *
 * Every one of them used to flatten the error to a message first — `error.message`,
 * `String(error)` — so the executor's refusal, which lives in `.cause`, never
 * reached a log line or the update panel. The logger has serialized `err.cause`
 * recursively all along; the defect was that nobody handed it an `err`.
 *
 * One test per surface, each asserting the CAUSE is present rather than that some
 * log line exists: a record naming only the wrapper is exactly the state this
 * issue is about.
 */

import { ACCESS_REFUSAL_MESSAGES, ACCESS_REFUSALS } from '@podium/model'
import { TRPCError } from '@trpc/server'
import { describe, expect, it, vi } from 'vitest'
import { CredentialRefError } from './modules/credentials/credential-ref'
import { credentialRefusedError, refusalInPlaceOfFault } from './modules/credentials/refusal-error'
import { CredentialRefusal } from './modules/sessions/launch-config'
import { assertSourceMatchesHead } from './modules/updates/dev-bundle'
import { releaseFailureLogs } from './modules/updates/dev-publisher-wiring'
import { runPersistenceSteps } from './shutdown'
import { captureLogs } from './test-support/capture-logs'
import { openTestStore } from './test-support/open-test-store'
import { errorShapeWithCause, logProcedureFailure } from './trpc'

/** The POD-3802 error: Drizzle's wrapper over the executor's refusal. */
function wrappedRefusal(): Error {
  const refusal = new Error('transaction 4 has an open nested scope (5)')
  refusal.name = 'ParallelNestedTransactionError'
  return new Error('Failed query: insert into "locks"', { cause: refusal })
}

const FULL_CHAIN =
  'Failed query: insert into "locks" ← ParallelNestedTransactionError: transaction 4 has an ' +
  'open nested scope (5)'

async function failureOf(work: Promise<unknown>): Promise<unknown> {
  return await work.then(
    () => undefined,
    (error: unknown) => error,
  )
}

describe('the tRPC error shape', () => {
  it('carries the cause chain tRPC drops, so a client is not left with the wrapper', () => {
    const shape: { message: string; data: Record<string, unknown> } = {
      message: 'Failed query: insert into "locks"',
      data: { code: 'INTERNAL' },
    }

    const formatted = errorShapeWithCause(shape, { cause: wrappedRefusal() })

    expect(formatted.data.causeChain).toBe(FULL_CHAIN)
    // Additive: the message a client already renders is untouched.
    expect(formatted.message).toBe('Failed query: insert into "locks"')
    expect(formatted.data.code).toBe('INTERNAL')
  })

  it('leaves a causeless error exactly as it was', () => {
    const shape: { message: string; data: Record<string, unknown> } = {
      message: 'not found',
      data: { code: 'NOT_FOUND' },
    }

    expect(errorShapeWithCause(shape, {})).toEqual(shape)
  })
})

describe('the release failure the update panel shows', () => {
  it('renders the cause chain instead of the wrapper alone', () => {
    expect(releaseFailureLogs(undefined, wrappedRefusal())).toBe(FULL_CHAIN)
  })

  it('still prefers the publisher own diagnostic, which names the offending paths', () => {
    expect(releaseFailureLogs('dist/podium is missing', wrappedRefusal())).toBe(
      'dist/podium is missing',
    )
  })
})

describe('the development bundle refusing an unverifiable checkout', () => {
  it('names what git actually failed on, not just that verification failed', async () => {
    // POD-3824. `DevBundleUnavailableError`'s internal message is the whole
    // record of why a dev publish was refused; flattening the throw to its own
    // message left `spawn git ENOENT` with no way to reach the reason.
    const failed = await failureOf(
      assertSourceMatchesHead('/repo', 'abc1234', () => {
        throw new Error('spawn git ENOENT', { cause: new Error('PATH contains no git') })
      }),
    )

    expect(failed).toBeInstanceOf(Error)
    expect((failed as Error).message).toContain('spawn git ENOENT ← PATH contains no git')
  })
})

describe('a shutdown step that fails', () => {
  it('hands the logger the error, so the record keeps the cause and its stack', async () => {
    const logs = captureLogs()
    try {
      await runPersistenceSteps([
        [
          'flushActivity',
          () => {
            throw wrappedRefusal()
          },
        ],
      ])

      const record = logs
        .at('error')
        .find((entry) => entry.msg.includes("shutdown step 'flushActivity' failed"))
      expect(record, 'a failed persistence step must still be logged').toBeDefined()
      expect(record?.err).toMatchObject({
        message: 'Failed query: insert into "locks"',
        cause: { name: 'ParallelNestedTransactionError' },
      })
      expect(record?.msg).toContain(FULL_CHAIN)
    } finally {
      logs.restore()
    }
  })
})

describe('the store executor refusing a statement', () => {
  it('logs the refusal at the source, with the lane, the frame and the open site', async () => {
    // WOULD CATCH the POD-3802 silence: the refusal reached the caller as
    // Drizzle's wrapper and the executor said nothing, so the only record of a
    // wedged lock queue was the wrapper text in an update panel.
    const logs = captureLogs()
    const store = await openTestStore(':memory:')
    let release = (): void => undefined
    const parked = new Promise<void>((resolve) => {
      release = resolve
    })
    try {
      const refused = await store.transact(async () => {
        // A second nested scope while the first is still open: savepoints are a
        // stack, so the executor refuses rather than interleaving.
        const branch = store.transact(async () => {
          await parked
        })
        const blocked = await failureOf(store.transact(async () => undefined))
        release()
        await branch
        return blocked
      })

      expect(refused).toBeInstanceOf(Error)
      const record = logs
        .at('error')
        .find((entry) => entry.msg === 'store executor refused a statement')
      expect(record, 'a refusal must leave exactly the line that was missing').toBeDefined()
      expect(record?.label).toBe('transact')
      expect(record?.lane).toBe('write')
      expect(typeof record?.frameId).toBe('number')
      expect(record?.err).toMatchObject({ name: 'ParallelNestedTransactionError' })
      // The stack must name the CALLER's site. A capture taken inside the frame
      // would name only the executor, which is true and of no use.
      expect(String(record?.openedAt)).toContain('error-chain-surfaces.test.ts')
      expect(String(record?.nestedOpenedAt)).toContain('error-chain-surfaces.test.ts')
    } finally {
      await store.close()
      logs.restore()
    }
  })
})

/** A plain throw as tRPC's own procedure call wraps it: a 500 with the throw as its cause. */
const asFault = (cause: Error) =>
  new TRPCError({ code: 'INTERNAL_SERVER_ERROR', message: cause.message, cause })

describe('a credential refusal at the tRPC boundary (POD-7066)', () => {
  it('enumerates the closed list it maps (canary)', () => {
    expect(ACCESS_REFUSALS.length).toBe(11)
  })

  for (const refusal of ACCESS_REFUSALS) {
    const sentence = ACCESS_REFUSAL_MESSAGES[refusal]
    it(`${refusal}: a 500 becomes PRECONDITION_FAILED carrying the sentence and the code`, () => {
      for (const thrown of [
        new CredentialRefusal(refusal, sentence),
        new CredentialRefError(sentence, refusal),
        new Error('the session could not start', {
          cause: new CredentialRefusal(refusal, sentence),
        }),
      ]) {
        const answered = refusalInPlaceOfFault(asFault(thrown))
        expect(answered?.code).toBe('PRECONDITION_FAILED')
        expect(answered?.message).toBe(sentence)
        const shape = errorShapeWithCause({ message: sentence, data: {} }, answered ?? {})
        // The code, and no cause chain repeating the sentence.
        expect(shape.data).toEqual({ refusalCode: `credential:${refusal}` })
      }
    })
  }

  it('leaves a real fault, a reference refusal without a code, and a 4xx alone', () => {
    expect(refusalInPlaceOfFault(asFault(new Error('disk full')))).toBeUndefined()
    expect(
      refusalInPlaceOfFault(asFault(new CredentialRefError('No credential is labelled "x".'))),
    ).toBeUndefined()
    expect(refusalInPlaceOfFault(credentialRefusedError('revoked', 'gone'))).toBeUndefined()
  })

  it('logs a refusal as one line with its code and no stack; a fault keeps its error', () => {
    const log = { info: vi.fn(), warn: vi.fn() }
    logProcedureFailure(log, {
      error: credentialRefusedError(
        'connection-not-encrypted',
        ACCESS_REFUSAL_MESSAGES['connection-not-encrypted'],
      ),
      path: 'sessions.create',
      type: 'mutation',
    })
    expect(log.warn).not.toHaveBeenCalled()
    expect(log.info).toHaveBeenCalledWith('tRPC procedure refused', {
      callType: 'mutation',
      path: 'sessions.create',
      code: 'PRECONDITION_FAILED',
      refusal: 'connection-not-encrypted',
    })

    const fault = asFault(new Error('disk full'))
    logProcedureFailure(log, { error: fault, path: 'sessions.create', type: 'mutation' })
    expect(log.warn).toHaveBeenCalledWith(
      'tRPC procedure failed',
      expect.objectContaining({ code: 'INTERNAL_SERVER_ERROR', err: fault }),
    )
  })
})
