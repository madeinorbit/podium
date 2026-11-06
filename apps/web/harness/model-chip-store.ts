/** The runtime the model chip reads, stood down for the harness (POD-6523):
 *  a change is accepted and never answered, so the pending state stays put. */
const state = {
  configureSession: async () => 'eff_harness_asked',
}
export function useRuntimeSelector<T>(pick: (s: typeof state) => T): T {
  return pick(state)
}
