import { Reaction } from 'mobx'
import { _observerFinalizationRegistry } from 'mobx-react-lite'
import type { MobxPool } from './pool'

/** Readers return identities owned by their memoized row/band projections.
 * Small scalar tuples may opt into an explicit equality function. */
export const samePoolProjection = Object.is

/** React's scalar/layout readers share MobX tracking without eagerly loading
 * the graph before pool startup. Rows use observer directly; this seam is for the
 * palette and project controls, which need only a small section projection.
 * Optional diagnostics let the structural harness observe this real boundary;
 * the app uses reference equality by default. */
export function createPoolProjection<T>(
  pool: MobxPool,
  read: (pool: MobxPool) => T,
  options: {
    name?: string
    equals?: (before: T, next: T) => boolean
    /** Visited folds retain lazy dependencies, without reading hidden changes. */
    retainWhileInactive?: boolean
  } = {},
) {
  const state = projectionState(pool, read, options)
  const view = {
    /** Hidden owners retain their last paint. A visited fold can also retain
     * its lazy graph: invalidation only marks it dirty until it is revealed. */
    setActive(active: boolean): void {
      if (state.active === active) return
      state.active = active
      state.dirty = true
      if (!active && !state.retainWhileInactive) {
        state.reaction?.dispose()
        state.reaction = null
        _observerFinalizationRegistry.unregister(state)
      }
    },
    getSnapshot(nextRead = state.read): T {
      if (state.read !== nextRead) {
        state.read = nextRead
        state.dirty = true
      }
      if (!state.active) {
        if (state.snapshot === null)
          throw new Error('An inactive projection has no painted snapshot')
        return state.snapshot.value
      }
      if (observeProjection(state) && !state.listeners.size) {
        // React can abandon a render before subscribing. Use the same cleanup
        // as observer components, including its fallback on engines without GC hooks.
        _observerFinalizationRegistry.register(view, state, state)
      }
      refreshProjection(state)
      if (state.error !== null) throw state.error.cause
      return state.snapshot!.value
    },
    subscribe(wake: () => void): () => void {
      const before = state.snapshot,
        error = state.error,
        version = state.version
      if (state.active) observeProjection(state)
      // Lazy reader construction can publish observable initialization during
      // tracking. Settle those real changes before attaching an imperative watch.
      while (state.active && state.dirty) refreshProjection(state)
      _observerFinalizationRegistry.unregister(state)
      const listener = () => wake()
      state.listeners.add(listener)
      // Imperative readers paint before subscribing. A lazy source can finish
      // initialization during that read; publish its newer snapshot at attachment.
      if (
        (before !== null || error !== null || state.version !== version) &&
        (state.snapshot !== before || state.error !== error)
      )
        wake()
      return () => {
        state.listeners.delete(listener)
        releaseProjection(state)
        if (state.reaction !== null && !state.listeners.size)
          _observerFinalizationRegistry.register(view, state, state)
      }
    },
    /** The hook's owner releases retained dependencies when it unmounts. */
    dispose(): void {
      state.reaction?.dispose()
      state.reaction = null
      state.dirty = true
      _observerFinalizationRegistry.unregister(state)
    },
  }
  return view
}

interface ProjectionState<T> {
  readonly pool: MobxPool
  readonly name: string
  readonly equals: (before: T, next: T) => boolean
  readonly retainWhileInactive: boolean
  read: (pool: MobxPool) => T
  snapshot: { value: T } | null
  error: { cause: unknown } | null
  dirty: boolean
  active: boolean
  version: number
  reaction: Reaction | null
  readonly listeners: Set<() => void>
}

/** MobX checks computed staleness before calling a Reaction's invalidator.
 * A hidden retained fold must pause before that check, otherwise marking the
 * snapshot dirty would already have recomputed its entire row graph. */
class ProjectionReaction<T> extends Reaction {
  constructor(private readonly state: ProjectionState<T>, invalidate: () => void) {
    super(state.name, invalidate)
  }

  override runReaction_(): void {
    if (!this.state.active && this.state.retainWhileInactive) {
      this.isScheduled = false
      this.state.dirty = true
      this.state.version++
      return
    }
    super.runReaction_()
  }
}

// These helpers stay outside createPoolProjection: reaction closures must not
// share a context with the view, or they would retain the finalization target.
function projectionState<T>(
  pool: MobxPool,
  read: (pool: MobxPool) => T,
  options: {
    name?: string
    equals?: (before: T, next: T) => boolean
    retainWhileInactive?: boolean
  },
): ProjectionState<T> {
  return {
    pool,
    name: options.name ?? 'pool projection',
    equals: options.equals ?? samePoolProjection,
    retainWhileInactive: options.retainWhileInactive ?? false,
    read,
    snapshot: null,
    error: null,
    dirty: true,
    active: true,
    version: 0,
    reaction: null,
    listeners: new Set(),
  }
}

function observeProjection<T>(state: ProjectionState<T>): boolean {
  if (state.reaction !== null) return false
  state.dirty = true
  state.reaction = new ProjectionReaction(state, () => {
    state.dirty = true
    state.version++
    // Filter before notifying React or imperative consumers: equal projections
    // must not trigger owner renders, even when an observed input changes.
    if (state.active && state.listeners.size) {
      const before = state.snapshot,
        error = state.error
      refreshProjection(state)
      if (state.snapshot !== before || state.error !== error)
        for (const listener of [...state.listeners]) listener()
    }
  })
  return true
}

function refreshProjection<T>(state: ProjectionState<T>): void {
  if (!state.dirty) return
  state.dirty = false
  state.error = null
  let next!: T
  state.reaction!.track(() => {
    try {
      next = state.read(state.pool)
    } catch (cause) {
      state.error = { cause }
    }
  })
  if (
    state.error === null &&
    (state.snapshot === null || !state.equals(state.snapshot.value, next))
  )
    state.snapshot = { value: next }
}

function releaseProjection<T>(state: ProjectionState<T>): void {
  if (state.listeners.size) return
  if (!state.active && state.retainWhileInactive) return
  state.reaction?.dispose()
  state.reaction = null
}

