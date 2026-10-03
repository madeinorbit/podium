type Omissions = Pick<ReadonlySet<PropertyKey>, 'has'>

// All three inputs are borrowed identities. Weak keys let a replaced or
// evicted row (and its obsolete overlays) go without a pool-wide copy index.
const overlays = new WeakMap<object, WeakMap<object, WeakMap<Omissions, object>>>()

/** One frozen shallow view per row, override and omission identity.
 * Call only for an addressed resident row or its declared cold summary. */
export function overlayRow<T extends object, O extends object>(
  row: T,
  overrides: Readonly<O>,
  omitted: Omissions = NO_OMISSIONS,
): T & O {
  let byOverride = overlays.get(row)
  if (!byOverride) overlays.set(row, byOverride = new WeakMap())
  let byOmission = byOverride.get(overrides)
  if (!byOmission) byOverride.set(overrides, byOmission = new WeakMap())
  const previous = byOmission.get(omitted)
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
  byOmission.set(omitted, value)
  return value
}

const NO_OMISSIONS = Object.freeze({ has: () => false })
