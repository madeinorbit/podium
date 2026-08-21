/**
 * THE LIVE MODEL CATALOG, STOOD DOWN (POD-1457).
 *
 * `useModelCatalog` reads `trpc` off the REAL store provider rather than the
 * `@/app/store` stub a harness swaps in, so any harness that mounts a model
 * picker throws on the context it never sets up. Returning an empty catalog
 * puts the pickers on their static fallback — which is what an operator sees
 * before the first fetch lands anyway.
 */
export function useModelCatalog(): Record<string, never> {
  return {}
}
