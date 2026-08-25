import {
  closestCenter,
  type CollisionDetection,
  DndContext,
  type DraggableAttributes,
  type DraggableSyntheticListeners,
  DragOverlay,
  KeyboardSensor,
  PointerSensor,
  pointerWithin,
  useDroppable,
  useSensor,
  useSensors,
} from '@dnd-kit/core'
import {
  horizontalListSortingStrategy,
  sortableKeyboardCoordinates,
  SortableContext,
  useSortable,
} from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'
import { type CSSProperties, type JSX, type ReactNode, useEffect } from 'react'

export interface TabDragPointerEventSnapshot {
  pointerId: number
  pointerType: string
  isPrimary: boolean
  button: number
  buttons: number
  clientX: number
  clientY: number
  ctrlKey: boolean
  shiftKey: boolean
  altKey: boolean
  metaKey: boolean
}

export interface TabDragKeyboardEventSnapshot {
  key: string
  code: string
  ctrlKey: boolean
  shiftKey: boolean
  altKey: boolean
  metaKey: boolean
  repeat: boolean
}

export type PendingTabDragActivation =
  | {
      kind: 'pointer'
      target: HTMLElement
      start: TabDragPointerEventSnapshot
      latestMove: TabDragPointerEventSnapshot | null
      end: TabDragPointerEventSnapshot | null
    }
  | {
      kind: 'keyboard'
      target: HTMLElement
      events: TabDragKeyboardEventSnapshot[]
    }

export interface TabDragItemBindings {
  attributes: DraggableAttributes
  listeners: DraggableSyntheticListeners
  setNodeRef: (node: HTMLElement | null) => void
  style: CSSProperties
  isDragging: boolean
}

interface TabDragStripProps {
  id: string
  children: (bindings: {
    setNodeRef: (node: HTMLElement | null) => void
    isOver: boolean
  }) => ReactNode
}

interface TabDragListProps {
  items: readonly string[]
  children: ReactNode
}

interface TabDragItemProps {
  id: string
  children: (bindings: TabDragItemBindings) => ReactNode
}

interface TabDropZoneProps {
  id: string
  children: (bindings: {
    setNodeRef: (node: HTMLElement | null) => void
    isOver: boolean
  }) => ReactNode
}

export interface TabDragComponents {
  Strip: (props: TabDragStripProps) => JSX.Element
  List: (props: TabDragListProps) => JSX.Element
  Item: (props: TabDragItemProps) => JSX.Element
  DropZone: (props: TabDropZoneProps) => JSX.Element
}

/** Prefer the precise nested target under the pointer, then the nearest pane. */
const paneCollision: CollisionDetection = (args) => {
  const inside = pointerWithin(args)
  return inside.length > 0 ? inside : closestCenter(args)
}

function Strip({ id, children }: TabDragStripProps): JSX.Element {
  const { setNodeRef, isOver } = useDroppable({ id })
  return <>{children({ setNodeRef, isOver })}</>
}

function List({ items, children }: TabDragListProps): JSX.Element {
  return (
    <SortableContext items={[...items]} strategy={horizontalListSortingStrategy}>
      {children}
    </SortableContext>
  )
}

function Item({ id, children }: TabDragItemProps): JSX.Element {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id,
  })
  return (
    <>
      {children({
        attributes,
        listeners,
        setNodeRef,
        style: { transform: CSS.Transform.toString(transform), transition },
        isDragging,
      })}
    </>
  )
}

function DropZone({ id, children }: TabDropZoneProps): JSX.Element {
  const { setNodeRef, isOver } = useDroppable({ id })
  return <>{children({ setNodeRef, isOver })}</>
}

const components: TabDragComponents = { Strip, List, Item, DropZone }

export interface WorkspaceTabDragRuntimeProps {
  children: (components: TabDragComponents) => ReactNode
  overlay: ReactNode
  onDragStart: (tabId: string) => void
  onDragEnd: (activeId: string, overId: string | null) => void
  onDragCancel: () => void
  onReady: () => PendingTabDragActivation | null
}

const pointerEvent = (
  type: 'pointerdown' | 'pointermove' | 'pointerup',
  snapshot: TabDragPointerEventSnapshot,
): PointerEvent =>
  new PointerEvent(type, {
    bubbles: true,
    cancelable: true,
    composed: true,
    ...snapshot,
  })

const keyboardEvent = (snapshot: TabDragKeyboardEventSnapshot): KeyboardEvent =>
  new KeyboardEvent('keydown', {
    bubbles: true,
    cancelable: true,
    composed: true,
    ...snapshot,
  })

export function WorkspaceTabDragRuntime({
  children,
  overlay,
  onDragStart,
  onDragEnd,
  onDragCancel,
  onReady,
}: WorkspaceTabDragRuntimeProps): JSX.Element {
  // Keep the five-pixel pointer threshold that separates a click from a drag.
  // The keyboard sensor uses dnd-kit's sortable coordinates so the same items
  // can be picked up with Space, moved with arrows, and cancelled with Escape.
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  )
  useEffect(() => {
    const pending = onReady()
    if (!pending) return

    if (pending.kind === 'pointer') {
      pending.target.dispatchEvent(pointerEvent('pointerdown', pending.start))
      if (!pending.latestMove) return
      const move = pending.latestMove
      let cancelled = false
      let releaseFrame: number | null = null
      let collisionFrame: number | null = null
      // PointerSensor installs its document listeners synchronously. Cross its
      // threshold now so a physical release in the next browser task is owned
      // by dnd-kit, then restore the buffered position after React commits start.
      pending.target.ownerDocument.dispatchEvent(pointerEvent('pointermove', move))
      queueMicrotask(() => {
        if (cancelled) return
        pending.target.ownerDocument.dispatchEvent(pointerEvent('pointermove', move))
        const end = pending.end
        if (!end) return
        // A completed cold gesture needs the collision effect to publish `over`
        // before pointerup asks the sensor to resolve the drop.
        collisionFrame = window.requestAnimationFrame(() => {
          releaseFrame = window.requestAnimationFrame(() => {
            pending.target.ownerDocument.dispatchEvent(pointerEvent('pointerup', end))
          })
        })
      })
      return () => {
        cancelled = true
        if (collisionFrame !== null) window.cancelAnimationFrame(collisionFrame)
        if (releaseFrame !== null) window.cancelAnimationFrame(releaseFrame)
      }
    }

    pending.target.dispatchEvent(keyboardEvent(pending.events[0]!))
    if (pending.events.length === 1) return
    // KeyboardSensor attaches its document listener in the next task. Replay
    // navigation and completion keys only after that listener exists.
    const timers: number[] = []
    const replay = (index: number): void => {
      const event = pending.events[index]
      if (!event) return
      timers.push(
        window.setTimeout(() => {
          pending.target.ownerDocument.dispatchEvent(keyboardEvent(event))
          replay(index + 1)
        }, 0),
      )
    }
    replay(1)
    return () => {
      for (const timer of timers) window.clearTimeout(timer)
    }
  }, [onReady])

  return (
    <DndContext
      sensors={sensors}
      collisionDetection={paneCollision}
      onDragStart={(event) => onDragStart(String(event.active.id))}
      onDragEnd={(event) =>
        onDragEnd(String(event.active.id), event.over ? String(event.over.id) : null)
      }
      onDragCancel={onDragCancel}
    >
      {children(components)}
      <DragOverlay dropAnimation={null}>{overlay}</DragOverlay>
    </DndContext>
  )
}
