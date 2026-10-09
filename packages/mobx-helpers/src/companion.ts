/** One view's companion per shared entity, allocated on first use. Neither
 * the view nor the factory keeps an entity alive after the pool releases it. */
export function companion<E extends object, C>(
  create: (entity: E) => C,
): ((entity: E) => C) & { clear(): void } {
  let values = new WeakMap<E, C>()
  const read = (entity: E) => {
    if (!values.has(entity)) values.set(entity, create(entity))
    return values.get(entity)!
  }
  // An opening can release its companions even while React retires the last
  // render or an in-flight handler still holds the disposed view model.
  return Object.assign(read, {
    clear() {
      values = new WeakMap<E, C>()
    },
  })
}
