/** Pool names are diagnostic data. Read the build and URL switches once at
 * startup, before any pool is built, and never interpolate a disabled name. */
function requested(): boolean {
  // Vite defines import.meta.env; Bun and Metro type it differently, so read
  // it through a local shape instead of augmenting the global ImportMeta.
  const env = (import.meta as { env?: { DEV?: boolean; MODE?: string } }).env
  if (env !== undefined) {
    if (env.DEV || env.MODE === 'test') return true
  }
  // Native tests and census tools have no Vite environment. Metro replaces
  // NODE_ENV for mobile builds, so its production path also omits names.
  else if (process.env.NODE_ENV !== 'production') return true
  try {
    // No DOM types in this package: read the browser location defensively.
    const location = (globalThis as { location?: { search: string } }).location
    if (location === undefined) return false
    const params = new URLSearchParams(location.search)
    return params.get('mobxSidebarCheck') === '1'
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
