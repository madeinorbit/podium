import { useRegisterSW as useRegisterSWVirtual } from 'virtual:pwa-register/react'
import type { RegisterSWOptions } from 'vite-plugin-pwa/types'

/** Keep the Vite virtual module behind a local seam for app code and tests. */
export function useRegisterSW(options?: RegisterSWOptions) {
  return useRegisterSWVirtual(options)
}
