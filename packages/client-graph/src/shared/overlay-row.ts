/** A read-only view over one borrowed row and a small override record.
 * No full record is copied or retained alongside the borrowed input. */
export function overlayRow<T extends object, O extends object>(
  row: T,
  overrides: Readonly<O>,
  omitted: ReadonlySet<PropertyKey> = NO_OMISSIONS,
): T & O {
  const read = (key: PropertyKey): unknown => omitted.has(key) ? undefined
    : Reflect.get(Object.hasOwn(overrides, key) ? overrides : row, key)
  const reject = (): never => { throw new TypeError('A pooled row overlay is read-only') }
  return new Proxy({} as T & O, {
    get: (_target, key) => read(key),
    has: (_target, key) => !omitted.has(key) && (Reflect.has(overrides, key) || Reflect.has(row, key)),
    ownKeys: () => [...new Set([...Reflect.ownKeys(row), ...Reflect.ownKeys(overrides)])].filter(key => !omitted.has(key)),
    getOwnPropertyDescriptor: (_target, key) =>
      omitted.has(key) || (!Object.hasOwn(row, key) && !Object.hasOwn(overrides, key)) ? undefined
        : { enumerable: true, configurable: true, get: () => read(key) },
    getPrototypeOf: () => Reflect.getPrototypeOf(row),
    set: reject, deleteProperty: reject, defineProperty: reject, setPrototypeOf: reject,
  })
}

const NO_OMISSIONS: ReadonlySet<PropertyKey> = new Set()
