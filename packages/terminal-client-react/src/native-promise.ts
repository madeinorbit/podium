/**
 * Normalize a standards-compatible thenable to a native Promise.
 *
 * Metro's web split-bundle loader deliberately returns a small PromiseLike
 * object with `then`, but without `catch` or `finally`. Consumers that share a
 * deferred import between Metro and Vite must cross this boundary before they
 * use native Promise methods.
 */
export function nativePromise<T>(thenable: PromiseLike<T>): Promise<T> {
  return Promise.resolve(thenable)
}
