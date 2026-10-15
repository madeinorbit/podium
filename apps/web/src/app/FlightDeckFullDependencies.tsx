import type { FullDeck, FullDeckTask } from '@podium/client-graph/mission-full-deck'
import { settled } from '@podium/client-graph/mission-view'
import { observer } from '@podium/client-graph/react'
import { lazy } from '@podium/mobx-helpers'
import { action, observable } from 'mobx'
import {
  createContext,
  type ReactNode,
  type RefObject,
  useContext,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react'
import {
  type DependencyLink,
  type DependencyPoint,
  dependencyEdges,
  dependencyPoint,
} from './flight-deck-full-edges'

/** Only transient view state lives here. Topology, phases and scheduling
 * relations are read from the existing Full companions, never reconstructed. */
class DependencyInteraction {
  @observable accessor hoveredId: string | null = null
  @observable accessor focusedId: string | null = null
  constructor(readonly full: FullDeck) {}

  @action hover(id: string | null) {
    this.hoveredId = id
  }
  @action focus(id: string | null) {
    this.focusedId = id
  }
  @lazy get activeId(): string | null {
    if (!this.hoveredId && !this.focusedId) return null
    const ids = settled(() => this.full.rowIds)
    return Array.isArray(ids)
      ? ([this.hoveredId, this.focusedId].find((id) => id !== null && ids.includes(id)) ?? null)
      : null
  }
  @lazy get directIds(): ReadonlySet<string> {
    const id = this.activeId
    if (!id) return new Set()
    const task = this.full.task(id)
    return new Set([id, ...task.blockedByIds, ...task.dependentIds])
  }
  @lazy get ancestorIds(): ReadonlySet<string> {
    const ancestors = new Set<string>()
    for (const id of this.directIds) {
      if (!this.full.members.has(id)) continue
      let parent = this.full.task(id).parentId
      while (parent && parent !== this.full.rootId && !ancestors.has(parent)) {
        ancestors.add(parent)
        parent = this.full.task(parent).parentId
      }
    }
    return ancestors
  }
  @lazy get phaseId(): string | null {
    const id = this.activeId
    if (!id) return null
    const task = this.full.task(id)
    return task.kind === 'phase' ? id : task.phaseId
  }
  highlighted(task: FullDeckTask): boolean {
    return this.activeId !== task.id && this.directIds.has(task.id)
  }
  dimmed(task: FullDeckTask): boolean {
    return (
      this.activeId !== null &&
      task.kind !== 'phase' &&
      task.phaseId === this.phaseId &&
      !this.directIds.has(task.id) &&
      !this.ancestorIds.has(task.id)
    )
  }
  dimLead(task: FullDeckTask): boolean {
    return this.activeId !== null && task.id === this.phaseId && task.id !== this.activeId
  }
}

const DependencyContext = createContext<DependencyInteraction | null>(null)
export const useFullDependencyInteraction = () => useContext(DependencyContext)

type Layout = {
  width: number
  height: number
  expanded: boolean
  points: ReadonlyMap<string, DependencyPoint>
}
const emptyLayout: Layout = { width: 0, height: 0, expanded: false, points: new Map() }

function sameLayout(a: Layout, b: Layout): boolean {
  return (
    a.width === b.width &&
    a.height === b.height &&
    a.expanded === b.expanded &&
    a.points.size === b.points.size &&
    [...a.points].every(([id, point]) => {
      const other = b.points.get(id)
      return point.right === other?.right && point.y === other.y
    })
  )
}

const rowId = (target: EventTarget | null): string | null =>
  target instanceof Element
    ? (target.closest<HTMLElement>('[data-flight-task-row]')?.dataset.flightTaskRow ?? null)
    : null

/** One overlay over the Full task tree, outside the coordinator and proposals.
 * Event delegation leaves all row buttons, menus and session selection alone. */
export const FlightDeckFullDependencies = observer(function FlightDeckFullDependencies({
  full,
  scrollRef,
  children,
}: {
  full: FullDeck
  scrollRef: RefObject<HTMLElement | null>
  children: ReactNode
}) {
  const root = useRef<HTMLDivElement>(null)
  const interaction = useMemo(() => new DependencyInteraction(full), [full])
  const [layout, setLayout] = useState(emptyLayout)
  const rowIds = settled(() => full.rowIds)

  useLayoutEffect(() => {
    const container = root.current
    if (!container) return
    // Child layout effects can precede the ancestor's ref attachment on the
    // first commit. The mounted Full panel is already in the DOM then.
    const scroll = scrollRef.current ?? container.closest<HTMLElement>('.flight-full-panel')
    const panel = container.closest<HTMLElement>('.flight-full-panel') ?? scroll ?? container
    let frame: number | null = null
    const observed = new Set<Element>()
    const schedule = () => {
      if (frame === null) frame = requestAnimationFrame(measure)
    }
    const scrollChanged = () => {
      interaction.hover(null)
      schedule()
    }
    const resize = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(schedule)
    const measure = () => {
      frame = null
      const box = container.getBoundingClientRect()
      // CSS zoom/transforms change rects but not layout dimensions. SVG and
      // gutter hooks use layout pixels, as do the panel's responsive rungs.
      const scale = container.offsetWidth > 0 ? box.width / container.offsetWidth : 1
      if (!Number.isFinite(scale) || scale <= 0) return
      const clip = scroll?.getBoundingClientRect()
      const chrome = scroll?.querySelector('.deck-chrome')?.getBoundingClientRect()
      const top = Math.max(clip?.top ?? -Infinity, chrome?.bottom ?? -Infinity)
      const bottom = clip?.bottom ?? Infinity
      const points = new Map<string, DependencyPoint>()
      const rows = container.querySelectorAll<HTMLElement>('[data-flight-task-row]')
      const mounted = new Set<string>()
      const nextObserved = new Set<Element>([
        container,
        panel,
        ...(scroll ? [scroll] : []),
        ...rows,
      ])
      for (const node of observed)
        if (!nextObserved.has(node)) {
          resize?.unobserve(node)
          observed.delete(node)
        }
      for (const node of nextObserved)
        if (!observed.has(node)) {
          resize?.observe(node)
          observed.add(node)
        }
      for (const row of rows) {
        const id = row.dataset.flightTaskRow!
        mounted.add(id)
        const rect = row.getBoundingClientRect()
        if (
          rect.width <= 0 ||
          rect.height <= 0 ||
          row.closest('[hidden]') ||
          rect.bottom <= top ||
          rect.top >= bottom
        )
          continue
        points.set(id, dependencyPoint(rect, box, scale))
      }
      if (interaction.hoveredId && !mounted.has(interaction.hoveredId)) interaction.hover(null)
      if (interaction.focusedId && !container.contains(document.activeElement))
        interaction.focus(null)
      const next: Layout = {
        width: box.width / scale,
        height: box.height / scale,
        expanded: panel.clientWidth >= 860,
        points,
      }
      setLayout((previous) => (sameLayout(previous, next) ? previous : next))
    }
    const mutations = new MutationObserver(schedule)
    mutations.observe(container, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ['hidden', 'style', 'class'],
    })
    // Zoom is often applied to an ancestor rather than the task tree.
    for (
      let parent: HTMLElement | null = container.parentElement;
      parent;
      parent = parent.parentElement
    )
      mutations.observe(parent, { attributes: true, attributeFilter: ['style', 'class'] })
    scroll?.addEventListener('scroll', scrollChanged, { passive: true })
    window.addEventListener('resize', schedule)
    measure()
    return () => {
      mutations.disconnect()
      resize?.disconnect()
      scroll?.removeEventListener('scroll', scrollChanged)
      window.removeEventListener('resize', schedule)
      if (frame !== null) cancelAnimationFrame(frame)
    }
  }, [interaction, scrollRef])

  // Membership/folds/search are already projected by Full. Only mounted and
  // visible endpoints get pixels; no estimated or external endpoint is drawn.
  const links: DependencyLink[] = []
  if (Array.isArray(rowIds))
    for (const id of rowIds) {
      if (!layout.points.has(id)) continue
      const dependencies = settled(() => full.task(id).blockedByIds)
      if (Array.isArray(dependencies))
        for (const dependencyId of dependencies) links.push({ dependentId: id, dependencyId })
    }
  const currentIds = new Set(Array.isArray(rowIds) ? rowIds : [])
  const points = new Map([...layout.points].filter(([id]) => currentIds.has(id)))
  const edges = dependencyEdges(links, points, layout.expanded, interaction.activeId)
  return (
    <DependencyContext.Provider value={interaction}>
      <div
        ref={root}
        className="flight-full-groups"
        data-testid="flight-deck-full-groups"
        onPointerOver={(event) => interaction.hover(rowId(event.target))}
        onPointerMove={(event) => interaction.hover(rowId(event.target))}
        onPointerOut={(event) => interaction.hover(rowId(event.relatedTarget))}
        onPointerLeave={() => interaction.hover(null)}
        onFocusCapture={(event) => interaction.focus(rowId(event.target))}
        onBlurCapture={(event) =>
          interaction.focus(containerRow(event.relatedTarget, root.current))
        }
      >
        {children}
        <svg
          className="flight-full-dependency-edges"
          aria-hidden="true"
          data-testid="full-dependency-edges"
          width={layout.width}
          height={layout.height}
          style={{ pointerEvents: 'none' }}
        >
          {edges.map((edge) => (
            <g
              key={`${edge.dependentId}:${edge.dependencyId}`}
              data-dependency-source={edge.dependencyId}
              data-dependency-target={edge.dependentId}
              data-highlighted={edge.highlighted}
            >
              <path d={edge.path} fill="none" strokeWidth={edge.highlighted ? 1.5 : 1} />
              <circle cx={edge.x} cy={edge.sourceY} r={2} strokeWidth={1} />
              <path d={edge.arrow} fill="none" strokeWidth={edge.highlighted ? 1.5 : 1.2} />
            </g>
          ))}
        </svg>
      </div>
    </DependencyContext.Provider>
  )
})

function containerRow(target: EventTarget | null, container: HTMLElement | null): string | null {
  return target instanceof Node && container?.contains(target) ? rowId(target) : null
}
