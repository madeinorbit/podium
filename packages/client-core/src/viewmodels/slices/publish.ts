/**
 * SLICE PUBLICATION (POD-330) — compute each slice ONCE per change, no matter
 * how many components read it.
 *
 * The problem this exists for: components re-deriving the same view model in
 * useEffect swarms (ChatView had 15 effects, Superagent 8). Two components
 * reading the worklist meant deriving the worklist twice per publish, and a
 * third meant three times. A published slice is derived once per snapshot and
 * handed to every reader.
 *
 * ---------------------------------------------------------------------------
 * THE MEMOIZATION KEY IS SNAPSHOT IDENTITY BY DEFAULT.
 * ---------------------------------------------------------------------------
 *
 * `packages/client-core/src/react/provider.tsx` sets the bar this mechanism had
 * to clear, and it is the multi-user one rather than a performance one:
 *
 *   "it must invalidate on shrink-without-revision-change, not merely on
 *    update."
 *
 * Under the scoped feed (POD-1077) the principal's world can SHRINK when the
 * authority evicts a row — a removal from your VIEW that is not a deletion and
 * that moves no row's revision. Any cache keyed on entity identity, on a
 * dependency set of ids, or on a revision high-water mark is wrong under that,
 * because all three encode "a row I cannot see is merely LATE". Under scoping it
 * may be permanently invisible, and a cache that waits for it paints a stale row
 * forever.
 *
 * So the key here is the snapshot OBJECT. The runtime publishes a fresh snapshot
 * on any change, which makes an evict, a rescope and an ordinary update
 * indistinguishable to this cache: all three miss, all three re-derive from
 * whatever rows are visible NOW. It never remembers rows — only the last answer
 * for the last snapshot — so it cannot hold a row past its visibility.
 *
 * A slice may opt into `sourceEqual` when it explicitly names every source
 * identity and scalar its derivation reads. That is for large derived views
 * whose source contains unrelated, frequently changing fields. The guard is
 * owned by the slice definition rather than inferred here, so a scoped/evicted
 * collection remains a miss whenever that slice declares the collection as a
 * dependency. Definitions that cannot make that proof keep the identity key.
 *
 * This remains correct across the PRINCIPAL boundary because a new principal is
 * a new runtime and therefore a new publisher. Nothing here carries a value
 * across sign-out or account switching.
 *
 * Note what makes that structural rather than disciplined: this publisher is
 * GENERIC over its source and never sees an id, a revision or a collection. It
 * could not key on one if it wanted to. The wrong cache is not merely avoided
 * here — it is unwritable.
 *
 * It is correct across the PRINCIPAL boundary for the same reason. A new
 * principal is a new runtime and therefore a new snapshot, so the first read
 * after a switch misses. Nothing here has to be TOLD that a switch happened,
 * which is the property that makes it safe: a cache that must be told about
 * sign-out is a cache that one day will not be.
 *
 * ---------------------------------------------------------------------------
 * PRESENCE DOES NOT COME THROUGH HERE.
 * ---------------------------------------------------------------------------
 *
 * Presence (POD-1078) is stream-plane: ephemeral, identity-carrying, blank when
 * offline, no durable rows, no tombstones, cursor-rate. It must not enter the
 * memoized entity slices, the funnel, the oplog or any persisted snapshot, so it
 * gets its OWN ephemeral publisher and is deliberately not expressible as a
 * `SliceDefinition`. Nothing enforces that by type — what enforces it is that a
 * publisher only ever reads the entity snapshot it was given.
 *
 * Platform-neutral: no React, no DOM, no storage. The React binding is
 * `react/use-slice.ts`; mobile consumes the same publisher.
 */

/**
 * One published derivation.
 *
 * `derive` must be PURE and must read only what is in `source`. It may be called
 * at any time, and is called at most once per (slice, snapshot) pair.
 */
export interface SliceDefinition<TSource, T> {
  /** Stable name — used by the render-count probe and by diagnostics only. */
  readonly name: string
  derive(source: TSource): T
  /**
   * Optional identity guard applied to the NEW value against the previous one.
   * When it reports equal, the PREVIOUS value's identity is kept, so a consumer
   * comparing with Object.is sees "unchanged" and does not re-render.
   *
   * Defaults to Object.is — i.e. a derivation returning a fresh object every
   * time re-renders every time, which is the honest default: silently treating
   * two different objects as one is how a stale row survives an eviction.
   */
  isEqual?(a: T, b: T): boolean
  /**
   * Optional dependency guard for derivations that read only part of a larger
   * source. When it reports equal, the previous value is reused without
   * running `derive`; the definition must include every input its derivation
   * reads. Defaults to Object.is, preserving snapshot-identity invalidation.
   */
  sourceEqual?(previous: TSource, next: TSource): boolean
}

export function defineSlice<TSource, T>(
  def: SliceDefinition<TSource, T>,
): SliceDefinition<TSource, T> {
  return def
}

/** How many times each slice actually ran. The render-count probe reads this;
 *  nothing in the product may branch on it. */
export type SliceDerivationCounts = Readonly<Record<string, number>>

export interface SlicePublisher<TSource> {
  /** The slice's value for the CURRENT snapshot, deriving it if this is the
   *  first read for that snapshot and reusing it for every subsequent reader. */
  read<T>(def: SliceDefinition<TSource, T>): T
  /** Derivation counts since construction, by slice name. Instrumentation. */
  derivations(): SliceDerivationCounts
}

interface Entry {
  source: unknown
  value: unknown
}

/**
 * Build a publisher over a source snapshot getter.
 *
 * One publisher per runtime (per principal): `getSource` is the runtime's
 * `getSnapshot`, and the publisher's own lifetime is the runtime's, so nothing
 * survives a principal switch.
 */
export function createSlicePublisher<TSource>(getSource: () => TSource): SlicePublisher<TSource> {
  const entries = new Map<string, Entry>()
  const counts = new Map<string, number>()

  return {
    read<T>(def: SliceDefinition<TSource, T>): T {
      const source = getSource()
      const cached = entries.get(def.name)
      // SNAPSHOT IDENTITY, not contents, is the safe default: a shrink that
      // moves no revision still produces a new snapshot object, so it misses
      // here exactly like an update. A definition may provide a complete,
      // explicit dependency guard for a large slice with unrelated source
      // fields; store the newest source even when the value is reused so the
      // next comparison is against the current snapshot.
      const sourceEqual = def.sourceEqual ?? Object.is
      if (cached && sourceEqual(cached.source as TSource, source)) {
        entries.set(def.name, { source, value: cached.value })
        return cached.value as T
      }
      const next = def.derive(source)
      counts.set(def.name, (counts.get(def.name) ?? 0) + 1)
      const isEqual = def.isEqual ?? Object.is
      // Keep the previous identity when the value is equal, so consumers that
      // compare identities skip a render — but only after re-deriving, never
      // instead of it.
      const value =
        cached !== undefined && isEqual(cached.value as T, next) ? (cached.value as T) : next
      entries.set(def.name, { source, value })
      return value
    },
    derivations(): SliceDerivationCounts {
      return Object.fromEntries(counts)
    },
  }
}
