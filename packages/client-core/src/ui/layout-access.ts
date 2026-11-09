import { isLayoutKey, layoutKeyFromLegacy, layoutRowId, type UserId } from '@podium/model'
import { action, actionBound, observable, observableRef, reaction } from 'mobx'
import type { RecordsApi } from '../records'

/** A handle to the pool's userLayout records. It never retains row values. */
export class LayoutAccess {
  @observableRef private accessor read: ((key: string) => unknown) | undefined = undefined
  private readonly keys = observable.set<string>()
  constructor(
    private readonly userId: UserId,
    private readonly records: RecordsApi,
  ) {}
  @actionBound attach(read: (key: string) => unknown): () => void {
    this.read = read
    return action(() => {
      if (this.read === read) this.read = undefined
    })
  }
  get(key: string): unknown {
    const canonical = this.canonical(key)
    this.remember(canonical)
    return this.read?.(canonical)
  }
  @action private remember(key: string): void {
    this.keys.add(key)
  }
  set(key: string, value: unknown): void {
    void this.records.edit(
      { kind: 'userLayout', id: layoutRowId(this.userId, this.canonical(key)) },
      { value },
    )
  }
  clear(key: string): void {
    void this.records.remove({
      kind: 'userLayout',
      id: layoutRowId(this.userId, this.canonical(key)),
    })
  }
  subscribe(notify: (keys: ReadonlySet<string>) => void): () => void {
    return reaction(
      () => [...this.keys].map((key) => [key, this.read?.(key)] as const),
      (next, previous) => {
        const before = new Map(previous)
        notify(
          new Set(
            next.filter(([key, value]) => !Object.is(before.get(key), value)).map(([key]) => key),
          ),
        )
      },
    )
  }
  async hydrate(): Promise<void> {}
  private canonical(key: string): string {
    if (isLayoutKey(key)) return key
    const canonical = layoutKeyFromLegacy(key)
    if (canonical === null) throw new Error(`Not a synced layout key: ${key}`)
    return canonical
  }
}
