/** Pool names are diagnostic data. Read the build and URL switches once at
 * startup, before any pool is built, and never interpolate a disabled name. */
declare global {
  interface ImportMetaEnv {
    readonly DEV: boolean
    readonly MODE: string
  }
  interface ImportMeta { readonly env: ImportMetaEnv }
}

function requested(): boolean {
  if (typeof import.meta.env !== 'undefined') {
    if (import.meta.env.DEV || import.meta.env.MODE === 'test') return true
  }
  // Native tests and census tools have no Vite environment. Metro replaces
  // NODE_ENV for mobile builds, so its production path also omits names.
  else if (process.env.NODE_ENV !== 'production') return true
  try {
    if (typeof location === 'undefined') return false
    const params = new URLSearchParams(location.search)
    return params.get('perfPanel') === '1' || params.get('mobxSidebarCheck') === '1'
  } catch {
    return false
  }
}

// This startup diagnostic switch changes names only, never a derivation's
// answer. The app leaves it fixed; outside census tools may opt in before
// constructing the objects they measure.
// eslint-disable-next-line fence/no-hidden-state -- diagnostic configuration, not pool data
let enabled = requested()

/** Memory/census tools opt in before constructing the objects they attribute. */
export function enableDebugNames(): void {
  enabled = true
}

export function debugName(make: () => string): string | undefined {
  return enabled ? make() : undefined
}
