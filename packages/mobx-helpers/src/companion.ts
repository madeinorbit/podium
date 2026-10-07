/** One view's companion per shared entity, allocated on first use. Neither
 * the view nor the factory keeps an entity alive after the pool releases it. */
export function companion<E extends object, C>(create: (entity: E) => C): (entity: E) => C {
  const values = new WeakMap<E, C>()
  return entity => {
    if (!values.has(entity)) values.set(entity, create(entity))
    return values.get(entity)!
  }
}
