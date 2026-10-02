/** Pool names are diagnostic data. Read the build and URL switches once at
 * startup, before any pool is built, and never interpolate a disabled name. */
const env = (import.meta as ImportMeta & {
  readonly env?: { readonly DEV: boolean; readonly MODE: string }
}).env

function requested(): boolean {
  if (env?.DEV || env?.MODE === 'test') return true
  // Native tests and census tools have no Vite environment. Metro replaces
  // NODE_ENV for mobile builds, so its production path also omits names.
  if (env === undefined && process.env.NODE_ENV !== 'production') return true
  try {
    if (typeof location === 'undefined') return false
    const params = new URLSearchParams(location.search)
    return params.get('perfPanel') === '1' || params.get('mobxSidebarCheck') === '1'
  } catch {
    return false
  }
}

let enabled = requested()

/** Memory/census tools opt in before constructing the objects they attribute. */
export function enableDebugNames(): void {
  enabled = true
}

export function debugName(make: () => string): string | undefined {
  return enabled ? make() : undefined
}
