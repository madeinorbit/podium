/** Identity memo for immutable rows joined with immutable companions.
 * Most rows have one input tuple. Allocate a weak trie only when a second
 * tuple is actually read, preserving the first tuple's value on promotion. */
export interface JoinMemoCell<T> {
  value?: T
}

interface Branch<T> {
  next?: WeakMap<object, Branch<T>>
  cell?: JoinMemoCell<T>
}

type Entry<T> =
  | { keys: readonly object[]; cell: JoinMemoCell<T> }
  | { tree: Branch<T> }

export class JoinMemo<T> {
  private readonly rows = new WeakMap<object, Entry<T>>()

  cell(row: object, keys: readonly object[]): JoinMemoCell<T> {
    const previous = this.rows.get(row)
    if (previous === undefined) {
      const cell: JoinMemoCell<T> = {}
      this.rows.set(row, { keys: [...keys], cell })
      return cell
    }
    if ('keys' in previous) {
      if (keys.length === previous.keys.length && keys.every((key, at) => key === previous.keys[at]))
        return previous.cell
      const tree: Branch<T> = {}
      this.branch(tree, previous.keys).cell = previous.cell
      // Release the first tuple's strong companion references on promotion.
      // The trie keeps every subsequent tuple's companion keys weak.
      this.rows.set(row, { tree })
      return this.branch(tree, keys).cell ??= {}
    }
    return this.branch(previous.tree, keys).cell ??= {}
  }

  private branch(root: Branch<T>, keys: readonly object[]): Branch<T> {
    let branch = root
    for (const key of keys) {
      const next = branch.next ??= new WeakMap<object, Branch<T>>()
      let child = next.get(key)
      if (child === undefined) {
        child = {}
        next.set(key, child)
      }
      branch = child
    }
    return branch
  }
}
