import { describe, expect, it } from 'vitest'
import { nativePromise } from './native-promise'

function catchlessThenable<T>(value: T): PromiseLike<T> {
  return {
    // biome-ignore lint/suspicious/noThenProperty: this is Metro's intentional PromiseLike shape
    then(onFulfilled, onRejected) {
      return Promise.resolve(value).then(onFulfilled, onRejected)
    },
  }
}

describe('nativePromise', () => {
  it('adds native Promise methods to Metro-style thenables', async () => {
    const normalized = nativePromise(catchlessThenable({ mountSession: 'loaded' }))

    expect(normalized.catch).toBeTypeOf('function')
    expect(normalized.finally).toBeTypeOf('function')
    await expect(normalized).resolves.toEqual({ mountSession: 'loaded' })
  })
})
