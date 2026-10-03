type Omissions = Pick<ReadonlySet<PropertyKey>, 'has'>

// All three inputs are borrowed identities. Weak keys let a replaced or
// evicted row (and its obsolete overlays) go without a pool-wide copy index.
type RowOverlays = WeakMap<object, WeakMap<object, object>>
const overlays: RowOverlays = new WeakMap()
const omittedOverlays = new WeakMap<Omissions, RowOverlays>()

/** One frozen shallow view per row, override and omission identity.
 * Call only for an addressed resident row or its declared cold summary. */
export function overlayRow<T extends object, O extends object>(
  row: T,
  overrides: Readonly<O>,
  omitted: Omissions = NO_OMISSIONS,
): T & O {
  // Most joins omit nothing. A separate cache per omission policy avoids
  // allocating another WeakMap for every short-lived override record.
  let rows = overlays
  if (omitted !== NO_OMISSIONS) {
    const previous = omittedOverlays.get(omitted)
    if (previous) rows = previous
    else omittedOverlays.set(omitted, rows = new WeakMap())
  }
  let byOverride = rows.get(row)
  if (!byOverride) rows.set(row, byOverride = new WeakMap())
  const previous = byOverride.get(overrides)
  if (previous) return previous as T & O

  const value = Object.create(Object.getPrototypeOf(row)) as T & O
  // The old overlay exposed every own key, including symbols and originally
  // non-enumerable cells. Define data properties so setters (and __proto__)
  // cannot intercept the copy and later reads run no lookup or getter.
  for (const key of new Set([...Reflect.ownKeys(row), ...Reflect.ownKeys(overrides)])) {
    if (omitted.has(key)) continue
    Object.defineProperty(value, key, {
      value: Reflect.get(Object.hasOwn(overrides, key) ? overrides : row, key),
      enumerable: true, configurable: true, writable: true,
    })
  }
  Object.freeze(value)
  byOverride.set(overrides, value)
  return value
}

const NO_OMISSIONS = Object.freeze({ has: () => false })
