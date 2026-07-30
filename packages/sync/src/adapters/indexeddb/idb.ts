/**
 * THE NARROW IndexedDB SURFACE THIS ADAPTER NAMES — declared here, structurally,
 * rather than pulled in from `lib.dom`.
 *
 * `packages/sync`'s tsconfig extends `tooling/tsconfig/node.json`, whose `lib` is
 * `["ES2023"]` with no DOM. Widening it to admit this adapter would have handed
 * `window`, `document` and `localStorage` types to every kernel module in the
 * package — the precise capability `check-boundaries` rule 11 exists to withhold —
 * in order to name four interfaces in one directory. So the surface is declared
 * structurally instead, and it is deliberately the SMALLEST one that compiles:
 *
 *   - A real browser `IDBFactory` satisfies it structurally.
 *   - So does `fake-indexeddb`'s, which is what the tests run against.
 *   - So does a fault-injecting wrapper (`./test-support`), which is what makes a
 *     quota denial and a mid-transaction kill expressible at all.
 *
 * That last one is not a convenience. A quota test that cannot make a `put`
 * request FAIL never reaches the quota, and a crash test whose crash lands between
 * no writes proves nothing — both are the shape POD-306 found certifying its own
 * fixture. Taking the factory as a PARAMETER everywhere (never reaching a global)
 * is what lets the fault be injected at the request level, where a real device
 * produces it, rather than at a seam this adapter invented for the test's benefit.
 *
 * `browserIndexedDb()` is the one place a DOM global is read, and it is a
 * composition helper: no module in this adapter calls it.
 */

/** The `onsuccess`/`onerror` pair every IDB request carries. */
export interface IdbRequestLike<T> {
  result: T
  error: { name: string; message: string } | null
  onsuccess: ((this: unknown, ev: unknown) => void) | null
  onerror: ((this: unknown, ev: unknown) => void) | null
}

export interface IdbOpenRequestLike extends IdbRequestLike<IdbDatabaseLike> {
  onupgradeneeded: ((this: unknown, ev: unknown) => void) | null
  onblocked?: ((this: unknown, ev: unknown) => void) | null
  transaction: IdbTransactionLike | null
}

export interface IdbObjectStoreLike {
  put(value: unknown, key?: unknown): IdbRequestLike<unknown>
  delete(key: unknown): IdbRequestLike<unknown>
  get(key: unknown): IdbRequestLike<unknown>
  getAll(): IdbRequestLike<unknown[]>
  clear(): IdbRequestLike<unknown>
}

export interface IdbTransactionLike {
  objectStore(name: string): IdbObjectStoreLike
  abort(): void
  error: { name: string; message: string } | null
  oncomplete: ((this: unknown, ev: unknown) => void) | null
  onerror: ((this: unknown, ev: unknown) => void) | null
  onabort: ((this: unknown, ev: unknown) => void) | null
}

export interface IdbDatabaseLike {
  readonly objectStoreNames: { contains(name: string): boolean }
  createObjectStore(name: string, options?: { keyPath?: string | string[] }): IdbObjectStoreLike
  transaction(names: string | string[], mode?: 'readonly' | 'readwrite'): IdbTransactionLike
  close(): void
  onversionchange: ((this: unknown, ev: unknown) => void) | null
}

export interface IdbFactoryLike {
  open(name: string, version?: number): IdbOpenRequestLike
  deleteDatabase(name: string): IdbOpenRequestLike
}

/**
 * The one DOM global read in this package, behind a function nothing here calls.
 *
 * Composition (POD-307's client wiring) calls it; every module in this adapter
 * takes the factory as a parameter, which is what keeps the adapter instantiable
 * in a worker, in a test, and against a fault-injecting wrapper.
 */
export function browserIndexedDb(): IdbFactoryLike {
  const factory = (globalThis as { indexedDB?: IdbFactoryLike }).indexedDB
  if (factory === undefined) {
    throw new Error('IndexedDB is unavailable in this environment (ADR 6 D1: fall back in-memory)')
  }
  return factory
}

/**
 * A request as a promise.
 *
 * NEVER used for a request that must land INSIDE a transaction: awaiting one
 * yields to the event loop, and an IndexedDB transaction auto-closes when its
 * request queue drains at the end of a task. Requests enrolled in a live commit
 * are issued fire-and-forget from `publish()` and the TRANSACTION is awaited
 * instead (see `./store.ts`). This helper is for hydration and for the open
 * handshake, both of which own their own transaction.
 */
export function requestAsPromise<T>(request: IdbRequestLike<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    request.onsuccess = () => {
      resolve(request.result)
    }
    request.onerror = () => {
      reject(request.error ?? new Error('IndexedDB request failed'))
    }
  })
}

/** DOMException carries the reason on `.name`; that is the only quota signal there is. */
export function isQuotaError(error: unknown): boolean {
  if (error === null || typeof error !== 'object') return false
  const name = (error as { name?: unknown }).name
  return name === 'QuotaExceededError' || name === 'NS_ERROR_FILE_NO_DEVICE_SPACE'
}
