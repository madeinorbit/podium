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

export function WorkspaceTabDragRuntime({
  children,
  overlay,
  onDragStart,
  onDragEnd,
  onDragCancel,
  onReady,
}: {
  children: (components: TabDragComponents) => ReactNode
  overlay: ReactNode
  onDragStart: (tabId: string) => void
  onDragEnd: (activeId: string, overId: string | null) => void
  onDragCancel: () => void
  onReady: () => void
}): JSX.Element {
  // Keep the five-pixel pointer threshold that separates a click from a drag.
  // The keyboard sensor uses dnd-kit's sortable coordinates so the same items
  // can be picked up with Space, moved with arrows, and cancelled with Escape.
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  )
  useEffect(onReady, [onReady])

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
