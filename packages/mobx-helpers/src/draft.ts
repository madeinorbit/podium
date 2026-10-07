import { action, compareDefault, computed, makeObservable, observable, type ObservableMap } from 'mobx'

export interface DraftOptions<T, K extends keyof T, R> {
  /** The editable keys: each becomes a get/set property of the draft. */
  fields: readonly K[]
  /** Called once per `submit()` with only the changed values. */
  save: (changes: Partial<Pick<T, K>>) => R
}

/** The draft's own members, as mobx-utils `createViewModel` names them. */
export interface DraftState<T, K extends keyof T, R> {
  /** The source the draft edits. */
  readonly model: T
  /** True while any field holds a local value. */
  readonly isDirty: boolean
  /** A snapshot of the local values, keyed by field. */
  readonly changedValues: Map<K, T[K]>
  isPropertyDirty(key: K): boolean
  /** Drop every local value: each field follows the source again. */
  reset(): void
  resetProperty(key: K): void
  /** Hand every local value to `save` in ONE call, then drop them. Calls
   * nothing and answers undefined when no field is dirty. */
  submit(): R | undefined
}

export type Draft<T, K extends keyof T, R = unknown> = { -readonly [P in K]: T[P] } & DraftState<T, K, R>

/**
 * An edit draft over an existing record: mobx-utils `createViewModel`'s
 * surface, built on public MobX 7 APIs (`createViewModel` 6.1.1 fails on
 * MobX 7 and needs a MobX observable object as its source).
 *
 * Each field reads the local value once edited, else the source's LIVE value,
 * so an untouched field keeps following the source. Setting a field to the
 * source's current value drops its local value. `submit()` hands all changes
 * to `save` in one call, so one save is one combined edit. The source may be a
 * plain object or a class instance with getter fields; it is only read, never
 * made observable. The local values are observable and every write is an
 * action, so an `observer` re-renders on the draft fields it reads.
 */
export function draft<T extends object, K extends keyof T & string, R = unknown>(
  source: T,
  options: DraftOptions<T, K, R>,
): Draft<T, K, R> {
  return new EditDraft(source, options) as unknown as Draft<T, K, R>
}

class EditDraft<T extends object, K extends keyof T & string, R> implements DraftState<T, K, R> {
  // Shallow: an edited array or object is the caller's value, not converted.
  readonly #local: ObservableMap<K, T[K]> = observable.map(undefined, { deep: false, name: 'draft' })
  readonly #save: (changes: Partial<Pick<T, K>>) => R

  constructor(readonly model: T, { fields, save }: DraftOptions<T, K, R>) {
    this.#save = save
    makeObservable<EditDraft<T, K, R>>(this, { isDirty: computed, reset: action, resetProperty: action, submit: action })
    const local = this.#local
    for (const field of fields) {
      if (field in this) throw new TypeError(`draft field ${field} collides with a draft member`)
      Object.defineProperty(this, field, {
        enumerable: true,
        get: () => (local.has(field) ? local.get(field) : model[field]),
        set: action(`draft.${field}`, (value: T[K]) => {
          if (compareDefault(value, model[field])) local.delete(field)
          else local.set(field, value)
        }),
      })
    }
  }

  get isDirty(): boolean {
    return this.#local.size > 0
  }

  get changedValues(): Map<K, T[K]> {
    return new Map(this.#local)
  }

  isPropertyDirty(key: K): boolean {
    return this.#local.has(key)
  }

  reset(): void {
    this.#local.clear()
  }

  resetProperty(key: K): void {
    this.#local.delete(key)
  }

  submit(): R | undefined {
    if (this.#local.size === 0) return undefined
    const changes = Object.fromEntries(this.#local) as Partial<Pick<T, K>>
    // Save first: a save that throws keeps the edits. Clearing in the same
    // action lets the save's paint and the cleared draft land as one change.
    const result = this.#save(changes)
    this.#local.clear()
    return result
  }
}
