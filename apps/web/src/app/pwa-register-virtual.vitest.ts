import type { RegisterSWOptions } from 'vite-plugin-pwa/types'

/**
 * A STAND-IN FOR `virtual:pwa-register/react` UNDER VITEST (POD-3224).
 *
 * The virtual module is minted by the VitePWA plugin, which does not run in the
 * unit lane — so without this, `src/app/pwa-register.ts` cannot be imported at
 * all, and the only way any suite could get past it was to mock the wrapper
 * wholesale. That is exactly why the wrapper had no tests: the seam that made it
 * testable was the seam under test.
 *
 * This records the options the wrapper hands the library and hands back the
 * shape `useRegisterSW` returns, so a test can invoke a callback the way the
 * library would and observe what the wrapper did about it.
 *
 * Aliased in `vitest.config.ts`. It is NOT a general-purpose fake: nothing here
 * reproduces the library's own `installed`/`waiting`/`controlling` logic, and a
 * test that needs that should assert against `vite-plugin-pwa` itself.
 */

/** What the wrapper passed on its most recent call. */
export const registeredOptions: { current?: RegisterSWOptions } = {}

export function useRegisterSW(options?: RegisterSWOptions) {
  registeredOptions.current = options
  return {
    needRefresh: [false, () => {}] as [boolean, (value: boolean) => void],
    offlineReady: [false, () => {}] as [boolean, (value: boolean) => void],
    updateServiceWorker: async () => {},
  }
}
