import { useEffect, useLayoutEffect, useRef, useState } from 'react'

export const ROW_EXIT_MS = 500

export interface RowTransitionTarget<T> {
  key: string
  /** A key may move between placements (for example, open → closed). */
  placement: string
  value: T
}

export interface RowTransitionItem<T> extends RowTransitionTarget<T> {
  phase: 'stable' | 'entering' | 'exiting'
}

const slot = (item: Pick<RowTransitionTarget<unknown>, 'key' | 'placement'>) =>
  `${item.key}\u0000${item.placement}`

/**
 * Retains removed rows long enough for their exit to finish. A key that changes
 * placement exits its old lane first, then enters the new lane — the sidebar's
 * open → Closed handoff. Existing rows are returned in target order, so an
 * insertion makes its neighbours move before the new surface materialises.
 */
export function useRowTransitions<T>(targets: readonly RowTransitionTarget<T>[]): {
  items: readonly RowTransitionItem<T>[]
  settle: (key: string, placement: string) => void
} {
  const latestTargets = useRef(targets)
  latestTargets.current = targets
  const [items, setItems] = useState<readonly RowTransitionItem<T>[]>(() =>
    targets.map((target) => ({ ...target, phase: 'stable' })),
  )

  useLayoutEffect(() => {
    setItems((current) => {
      const currentBySlot = new Map(current.map((item) => [slot(item), item]))
      const targetSlots = new Set(targets.map(slot))
      const currentKeys = new Set(current.map((item) => item.key))
      const next: RowTransitionItem<T>[] = []

      for (const target of targets) {
        const previous = currentBySlot.get(slot(target))
        if (previous) {
          next.push({
            ...target,
            phase: previous.phase === 'entering' ? 'entering' : 'stable',
          })
        } else if (!currentKeys.has(target.key)) {
          next.push({ ...target, phase: 'entering' })
        }
        // When the key exists in another placement, withhold its destination
        // until the retained source row has completed its exit.
      }

      const exiting = current
        .map((item, index) => ({ item, index }))
        .filter(({ item }) => !targetSlots.has(slot(item)))
      for (const { item, index } of exiting) {
        next.splice(Math.min(index, next.length), 0, {
          ...item,
          phase: 'exiting',
        })
      }

      const unchanged =
        next.length === current.length &&
        next.every(
          (item, index) =>
            slot(item) === slot(current[index]!) &&
            item.phase === current[index]!.phase &&
            item.value === current[index]!.value,
        )
      return unchanged ? current : next
    })
  }, [targets])

  const hasExits = items.some((item) => item.phase === 'exiting')
  useEffect(() => {
    if (!hasExits) return
    const delay =
      typeof window.matchMedia === 'function' &&
      window.matchMedia('(prefers-reduced-motion: reduce)').matches
        ? 0
        : ROW_EXIT_MS
    const timer = window.setTimeout(() => {
      const targetItems = latestTargets.current
      setItems((current) => {
        const currentBySlot = new Map(current.map((item) => [slot(item), item]))
        return targetItems.map((target) => ({
          ...target,
          phase: currentBySlot.has(slot(target)) ? 'stable' : 'entering',
        }))
      })
    }, delay)
    return () => window.clearTimeout(timer)
  }, [hasExits])

  const settle = (key: string, placement: string): void => {
    const settledSlot = slot({ key, placement })
    setItems((current) => {
      let changed = false
      const next = current.map((item) => {
        if (slot(item) !== settledSlot || item.phase !== 'entering') return item
        changed = true
        return { ...item, phase: 'stable' as const }
      })
      return changed ? next : current
    })
  }

  return { items, settle }
}
