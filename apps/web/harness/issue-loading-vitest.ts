export { afterAll, afterEach } from './vitest-stub'

/** LoadRecorder imports this for optional test assertions, never for loading. */
export function expect(): never {
  throw new Error('Use browser assertions in the issue loading layout harness')
}
