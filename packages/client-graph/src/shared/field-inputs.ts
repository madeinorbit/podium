import { _isComputingDerivation, createAtom, type IAtom } from 'mobx'

/** A stable, frozen read facade over keyed inputs. Reading a field subscribes
 * only to that field; publication never compares or traverses another value.
 * Owned atoms exist only while a derivation observes the field. An owner can
 * lend an existing atom instead of allocating a duplicate. Owners batch writes. */
export function createFieldInputs<T extends object>(
  fields: readonly (keyof T)[],
  initial: Partial<T> | ((key: keyof T) => T[keyof T]) = {},
  name = 'inputs',
  borrowAtom?: (key: keyof T) => IAtom | undefined,
) {
  let values: Partial<T> = typeof initial === 'function' ? {} : { ...initial }
  let borrowed = typeof initial === 'function' ? initial : undefined
  const valueAt = (key: keyof T) => (Object.hasOwn(values, key) ? values[key] : borrowed?.(key))
  const atoms = new Map<keyof T, IAtom>()
  const row = Object.freeze(
    Object.defineProperties(
      {},
      Object.fromEntries(
        fields.map((key) => [
          key,
          {
            enumerable: true,
            get() {
              if (_isComputingDerivation()) {
                let atom = atoms.get(key)
                if (!atom) {
                  atom =
                    borrowAtom?.(key) ??
                    createAtom(`${name}:${String(key)}`, undefined, () => {
                      atoms.delete(key)
                    })
                  atoms.set(key, atom)
                }
                atom.reportObserved()
              }
              return valueAt(key)
            },
          },
        ]),
      ),
    ),
  ) as T
  return {
    row,
    set<K extends keyof T>(key: K, value: T[K]): boolean {
      if (Object.is(valueAt(key), value)) return false
      values[key] = value
      atoms.get(key)?.reportChanged()
      return true
    },
    /** Replace a borrowed resident row without eagerly copying its fields.
     * Only demanded fields need comparison; every getter reads the owner row. */
    replace(read: (key: keyof T) => T[keyof T]): void {
      const changed = [...atoms.keys()].filter((key) => !Object.is(valueAt(key), read(key)))
      values = {}
      borrowed = read
      for (const key of changed) atoms.get(key)?.reportChanged()
    },
  }
}
