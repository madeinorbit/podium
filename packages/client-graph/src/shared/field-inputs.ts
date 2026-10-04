import { _isComputingDerivation, createAtom, type IAtom } from 'mobx'

/** A stable, frozen read facade over keyed inputs. Reading a field subscribes
 * only to that field; publication never compares or traverses another value.
 * Atoms exist only while a derivation observes the field. Owners batch writes. */
export function createFieldInputs<T extends object>(
  fields: readonly (keyof T)[],
  initial: Partial<T> = {},
  name = 'inputs',
) {
  const values: Partial<T> = { ...initial }
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
                  atom = createAtom(`${name}:${String(key)}`, undefined, () => {
                    atoms.delete(key)
                  })
                  atoms.set(key, atom)
                }
                atom.reportObserved()
              }
              return values[key]
            },
          },
        ]),
      ),
    ),
  ) as T
  return {
    row,
    set<K extends keyof T>(key: K, value: T[K]): boolean {
      if (Object.is(values[key], value)) return false
      values[key] = value
      atoms.get(key)?.reportChanged()
      return true
    },
  }
}
