/** Runtime-only collection calls used by the opening lifetime test.
 * Keep this local, following packages/runtime/src/bun-jsc.d.ts, instead of
 * introducing Bun's global type package into the web program. */
declare module 'bun:jsc' {
  export function releaseWeakRefs(): void
  export function gcAndSweep(): void
}
