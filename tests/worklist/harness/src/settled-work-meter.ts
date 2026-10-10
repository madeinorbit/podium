/** Isolate each event from the prior synchronous fixture inspection. @lazy
 * releases unobserved fields on a microtask; its teardown belongs to that
 * inspection, not to the following scale's open. The meter remains unchanged. */
export * from './work-meter'
import { measureWork as measured } from './work-meter'
export async function measureWork<T>(fn: () => Promise<T>, options: Parameters<typeof measured>[1] = {}) {
  await Promise.resolve()
  await Promise.resolve()
  return measured(fn, options)
}
