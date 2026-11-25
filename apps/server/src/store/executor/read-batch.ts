/** Explicit groups of independent reads; SQL and decoding stay in their repositories. */
import { AsyncLocalStorage } from 'node:async_hooks'
import type { Statement, StatementResult } from './driver'

interface PendingRead {
  statement: Statement
  resolve(result: StatementResult): void
  reject(error: unknown): void
}

interface ReadGroup {
  active: boolean
  // Never mix executors, transaction frames, post-commit drains or root workspaces.
  queues: Map<object, Map<object, PendingRead[]>>
}

const storage = new AsyncLocalStorage<ReadGroup>()

/** Batch independent reads started together. Sequential dependencies still await normally.
 * The callback may only read, and must await its work. No memo survives this call. */
export async function withReadBatch<T>(run: () => Promise<T>): Promise<T> {
  if (storage.getStore()?.active) return await run()
  const group: ReadGroup = { active: true, queues: new Map() }
  try {
    return await storage.run(group, run)
  } finally {
    group.active = false
  }
}

/** Keep streaming lazy: batch a page's reads only while that page is requested. */
export async function* readBatchedPages<T>(pages: AsyncIterable<T>): AsyncGenerator<T> {
  const iterator = pages[Symbol.asyncIterator]()
  try {
    for (;;) {
      const next = await withReadBatch(async () => await iterator.next())
      if (next.done) return
      yield next.value
    }
  } finally {
    await iterator.return?.()
  }
}

export function assertReadBatchIntent(statement: Statement): void {
  if (statement.intent === 'write' && storage.getStore()?.active) {
    throw new Error('withReadBatch accepts independent reads only')
  }
}

/** The executor calls this only after its normal health, scope and intent checks. */
export function batchRead(
  executor: object,
  scope: object,
  statement: Statement,
  execute: (statements: readonly Statement[]) => Promise<readonly StatementResult[]>,
): Promise<StatementResult> | undefined {
  const group = storage.getStore()
  if (!group?.active) return undefined
  let scopes = group.queues.get(executor)
  if (!scopes) {
    scopes = new Map()
    group.queues.set(executor, scopes)
  }
  let pending = scopes.get(scope)
  if (!pending) {
    pending = []
    scopes.set(scope, pending)
    const queued = pending
    const queues = scopes
    queueMicrotask(() => {
      queues.delete(scope)
      void (async () => {
        try {
          const results = await execute(queued.map((read) => read.statement))
          if (results.length !== queued.length) throw new Error('read batch result count mismatch')
          queued.forEach((read, index) => {
            read.resolve(results[index]!)
          })
        } catch (error) {
          for (const read of queued) read.reject(error)
        }
      })()
    })
  }
  return new Promise((resolve, reject) => pending.push({ statement, resolve, reject }))
}
