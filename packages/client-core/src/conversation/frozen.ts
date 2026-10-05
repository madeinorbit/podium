/** Observable containers hold plain immutable values, including nested payloads.
 * Inspect data descriptors so diagnostic getters are never evaluated by freezing. */
export function freezePlain<T>(value: T): T {
  if (typeof process !== 'undefined' && process.env.NODE_ENV === 'production') return value
  const seen = new WeakSet<object>()
  const freeze = (entry: unknown): void => {
    if (!entry || typeof entry !== 'object' || seen.has(entry)) return
    seen.add(entry)
    for (const descriptor of Object.values(Object.getOwnPropertyDescriptors(entry))) {
      if ('value' in descriptor) freeze(descriptor.value)
    }
    Object.freeze(entry)
  }
  freeze(value)
  return value
}
