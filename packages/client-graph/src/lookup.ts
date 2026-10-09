import { LOADING, type Loaded } from './loading'

/** An addressed record has exactly three answers. Gone is terminal until a
 * later publication makes the record visible again; it never starts a load. */
export interface Gone {
  readonly kind: 'gone'
  readonly reason: 'removed' | 'not-visible'
}
export type Lookup<T> = T | typeof LOADING | Gone

export const REMOVED: Gone = Object.freeze({ kind: 'gone', reason: 'removed' })
export const NOT_VISIBLE: Gone = Object.freeze({ kind: 'gone', reason: 'not-visible' })

export function isGone(value: unknown): value is Gone {
  return typeof value === 'object' && value !== null &&
    (value as Gone).kind === 'gone' &&
    ((value as Gone).reason === 'removed' || (value as Gone).reason === 'not-visible')
}

/** A nullable view/list deliberately omits a gone record, while preserving
 * loading for its caller. The public lookup itself never answers undefined. */
export function omitGone<T>(answer: Lookup<T>): Loaded<T> {
  return isGone(answer) ? undefined : answer
}

/** Optional resident-only details/counts omit both pending and gone records.
 * The lookup has already requested a pending record's batched load. */
export function here<T>(answer: Lookup<T>): T | undefined {
  return answer === LOADING || isGone(answer) ? undefined : answer
}

/** Used when the caller requires a resident fixture or a resolved record. */
export function requireHere<T>(answer: Lookup<T>): T {
  if (answer === LOADING) throw LOADING
  if (isGone(answer)) throw new Error(`Record is gone (${answer.reason})`)
  return answer
}
