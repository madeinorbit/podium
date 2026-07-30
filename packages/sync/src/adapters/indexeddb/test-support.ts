/**
 * THE FAULT INSTRUMENTS, and why they are wrappers around a REAL IndexedDB rather
 * than a stand-in for one.
 *
 * The brief for this adapter is that crash and quota are the point, and the failure
 * mode this run has paid for six times is a gate whose refusing arm the test
 * environment cannot produce. Two of those arms are needed here:
 *
 *   QUOTA — a write must actually be DENIED by the storage engine, mid-transaction,
 *   after earlier writes in the same transaction have already been issued to it. A
 *   denial injected before the transaction opens never reaches the quota, and the
 *   "nothing partially applied" assertion it produces is vacuous: nothing was
 *   applied because nothing was attempted. {@link denyWriteAt} injects at request
 *   N of the live transaction, so the earlier requests are genuinely in flight and
 *   it is the engine's own abort that undoes them.
 *
 *   CRASH — a kill between writes must destroy the in-memory mirror and leave
 *   IndexedDB alone. `IndexedDbSyncStore.open()` again over the SAME factory is
 *   that kill: the surviving state is what committed, never what an object still
 *   held. There is deliberately no "reset the store" helper here, because a crash
 *   that keeps the object alive is the fixture certifying itself.
 *
 * `fake-indexeddb` is the engine. It is a spec implementation of IndexedDB with
 * real transaction semantics (request queues, auto-close, abort-undoes-the-batch),
 * which is what these tests need and what neither node, bun nor happy-dom
 * provides — see `docs/agents/pod-374-storage-evidence.md` for the measurement.
 */

import { IDBFactory } from 'fake-indexeddb'
import { ALL_STORES, REPLICA_DB_NAME, REPLICA_SCHEMA_VERSION, upgradeSchema } from './schema'
import type {
  IdbDatabaseLike,
  IdbFactoryLike,
  IdbObjectStoreLike,
  IdbOpenRequestLike,
  IdbRequestLike,
  IdbTransactionLike,
} from './idb'

/** A brand-new, empty IndexedDB origin. One per test; nothing is shared. */
export const freshFactory = (): IdbFactoryLike => new IDBFactory() as unknown as IdbFactoryLike

/**
 * Every durable row, read through a CONNECTION OF ITS OWN.
 *
 * Deliberately not `IndexedDbSyncStore`'s read path. An assertion about what
 * survived a crash, made through the object that was supposed to have died, is the
 * fixture certifying itself; this opens its own connection and reads the object
 * stores directly, so the adapter's mirror cannot answer for the engine.
 */
export async function readDurable(
  factory: IdbFactoryLike,
  databaseName: string = REPLICA_DB_NAME,
): Promise<Record<string, unknown[]>> {
  const db = await new Promise<IdbDatabaseLike>((resolve, reject) => {
    const request = factory.open(databaseName, REPLICA_SCHEMA_VERSION)
    request.onupgradeneeded = () => {
      upgradeSchema(request.result)
    }
    request.onsuccess = () => {
      resolve(request.result)
    }
    request.onerror = () => {
      reject(request.error ?? new Error('open failed'))
    }
  })
  const tx = db.transaction([...ALL_STORES], 'readonly')
  const out: Record<string, unknown[]> = {}
  for (const name of ALL_STORES) {
    out[name] = await new Promise<unknown[]>((resolve, reject) => {
      const request = tx.objectStore(name).getAll()
      request.onsuccess = () => {
        resolve(request.result)
      }
      request.onerror = () => {
        reject(request.error ?? new Error('getAll failed'))
      }
    })
  }
  db.close()
  return out
}

/** What a browser reports when the origin's quota is exhausted. */
export class QuotaExceededDomError extends Error {
  override readonly name = 'QuotaExceededError'
  constructor(message = 'The quota has been exceeded.') {
    super(message)
  }
}

/**
 * A fault the wrapper can inject. `at` counts WRITE REQUESTS (`put` + `delete`)
 * issued into a single transaction, from 0.
 */
export interface WriteFault {
  /** Deny the request at this index. `0` denies the first write of the transaction. */
  readonly at: number
  /**
   * `deny` refuses the request AT `at` — the quota shape, where the engine says no
   * to a write and takes the transaction down with it.
   *
   * `after` lets the request at `at` through and THEN kills the transaction, which
   * is the power-loss shape: every request was issued and accepted, and the commit
   * never happened. Both are boundaries a crash can land on and they are not the
   * same instant — `after: last` is the only way to reach "all writes in flight,
   * nothing committed", which no `deny` index can express.
   */
  readonly mode?: 'deny' | 'after'
  /** Defaults to a quota denial; a crash test passes something else to prove the
   *  adapter's quota branch is chosen by the ERROR and not by the injection point. */
  readonly error?: Error
  /** How many transactions this fault applies to before it disarms. Default 1. */
  readonly times?: number
}

/**
 * Wrap a factory so writes can be denied mid-transaction.
 *
 * The denial is faithful to what the engine does: the request's error is reported,
 * the REAL transaction is aborted (so everything already issued into it is undone
 * by IndexedDB and not by this wrapper), and the transaction's `error` reads back
 * as the injected one — which is how a browser surfaces a quota abort.
 */
export class FaultyIdbFactory implements IdbFactoryLike {
  private fault: WriteFault | undefined
  /** Write requests the wrapper has passed through to the engine, all transactions. */
  writesIssued = 0
  /** Transactions in which a fault fired. */
  denials = 0

  constructor(private readonly inner: IdbFactoryLike) {}

  /** Arm the next fault. Pass `undefined` to disarm. */
  denyWriteAt(fault: WriteFault | undefined): void {
    this.fault = fault
  }

  open(name: string, version?: number): IdbOpenRequestLike {
    const request = this.inner.open(name, version)
    return wrapOpenRequest(request, this)
  }

  deleteDatabase(name: string): IdbOpenRequestLike {
    return this.inner.deleteDatabase(name)
  }

  /** Consume one use of the armed fault, if any applies to a new transaction. */
  takeFault(): WriteFault | undefined {
    const fault = this.fault
    if (fault === undefined) return undefined
    const times = fault.times ?? 1
    if (times <= 1) this.fault = undefined
    else this.fault = { ...fault, times: times - 1 }
    return fault
  }
}

function wrapOpenRequest(request: IdbOpenRequestLike, factory: FaultyIdbFactory): IdbOpenRequestLike {
  const wrapper: IdbOpenRequestLike = {
    get result() {
      return wrapDatabase(request.result, factory)
    },
    get error() {
      return request.error
    },
    get transaction() {
      return request.transaction
    },
    onsuccess: null,
    onerror: null,
    onupgradeneeded: null,
  }
  request.onsuccess = (ev) => wrapper.onsuccess?.call(wrapper, ev)
  request.onerror = (ev) => wrapper.onerror?.call(wrapper, ev)
  request.onupgradeneeded = (ev) => wrapper.onupgradeneeded?.call(wrapper, ev)
  return wrapper
}

function wrapDatabase(db: IdbDatabaseLike, factory: FaultyIdbFactory): IdbDatabaseLike {
  return {
    objectStoreNames: db.objectStoreNames,
    createObjectStore: (name, options) => db.createObjectStore(name, options),
    close: () => {
      db.close()
    },
    get onversionchange() {
      return db.onversionchange
    },
    set onversionchange(handler) {
      db.onversionchange = handler
    },
    transaction: (names, mode) => wrapTransaction(db.transaction(names, mode), factory),
  }
}

function wrapTransaction(tx: IdbTransactionLike, factory: FaultyIdbFactory): IdbTransactionLike {
  const fault = factory.takeFault()
  let writeIndex = 0
  let injected: Error | undefined
  const wrapper: IdbTransactionLike = {
    objectStore: (name) => wrapObjectStore(tx.objectStore(name), () => deny(), () => killAfter()),
    abort: () => {
      tx.abort()
    },
    get error() {
      // The injected error, once it has fired: a browser reports the request's
      // failure as the transaction's error, and the adapter's quota branch keys on
      // exactly that. Falling back to the engine's own error keeps every other
      // abort honest.
      return injected !== undefined
        ? { name: injected.name, message: injected.message }
        : tx.error
    },
    oncomplete: null,
    onerror: null,
    onabort: null,
  }
  tx.oncomplete = (ev) => wrapper.oncomplete?.call(wrapper, ev)
  tx.onerror = (ev) => wrapper.onerror?.call(wrapper, ev)
  tx.onabort = (ev) => wrapper.onabort?.call(wrapper, ev)

  /** Returns the error to raise for this write, or undefined to let it through. */
  function deny(): Error | undefined {
    const index = writeIndex
    writeIndex += 1
    factory.writesIssued += 1
    if (fault === undefined || index !== fault.at) return undefined
    if ((fault.mode ?? 'deny') === 'after') return undefined
    injected = fault.error ?? new QuotaExceededDomError()
    factory.denials += 1
    // The REAL transaction is aborted, so everything already issued into it is
    // undone by IndexedDB itself. That is what makes "nothing partially applied"
    // an observation about the engine rather than about this wrapper.
    tx.abort()
    return injected
  }

  /** Power loss with every request already in flight: kill AFTER `at` was issued. */
  function killAfter(): void {
    if (fault === undefined || fault.mode !== 'after') return
    if (writeIndex - 1 !== fault.at) return
    injected = fault.error ?? new Error('power loss before commit')
    factory.denials += 1
    tx.abort()
  }

  return wrapper
}

function wrapObjectStore(
  store: IdbObjectStoreLike,
  deny: () => Error | undefined,
  killAfter: () => void,
): IdbObjectStoreLike {
  return {
    put: (value, key) => {
      const error = deny()
      if (error !== undefined) throw error
      const request = store.put(value, key)
      killAfter()
      return request
    },
    delete: (key) => {
      const error = deny()
      if (error !== undefined) throw error
      const request = store.delete(key)
      killAfter()
      return request
    },
    get: (key) => store.get(key) as IdbRequestLike<unknown>,
    getAll: () => store.getAll(),
    clear: () => store.clear(),
  }
}
