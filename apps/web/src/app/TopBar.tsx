import { shallowEqual } from '@podium/client-core/store'
import {
  BarChart3,
  CalendarClock,
  FileText,
  LayoutPanelLeft,
  Minus,
  Settings,
  Square,
  SquareKanban,
  Workflow,
  X,
} from 'lucide-react'
import type { ComponentType, JSX } from 'react'
import { HeaderHostIndicators } from '@/features/machines/HostIndicators'
import { PodiumLogo } from '@/lib/icons/PodiumLogo'
import { type NativeDesktopBridge, nativeDesktopBridge } from '@/lib/nativeDesktop'
import { useFeature } from '@/lib/use-feature'
import { cn } from '@/lib/utils'
import { type MainView, useReplicaIssues, useStoreSelector } from './store'
import { ToolbarSlotTarget, useToolbarSlotFilled } from './ToolbarSlot'

/**
 * THE COMMAND BAR (POD-365) — 44px, four zones, left to right:
 *
 *   mark │ mode tabs │ ─ │ mode-contextual slot │ ⇠gap⇢ │ instrument well │ ─ │ utilities
 *
 * The zones are fixed; only the slot's contents change. [spec:SP-3834] The same
 * header becomes the native app's integrated title bar.
 *
 * WHY IT LOOKS LIKE THIS. The bar previously read as a marketing-site header —
 * mark hard left, bare text links beside it, a dead middle, readouts trailing
 * off the right edge. Three things fix the genre without removing anything:
 *
 * 1. MODES ARE BOUNDED, NOT LINKED. Unbounded text is a hyperlink affordance;
 *    an icon with a label inside a container is an app affordance. Only the
 *    ACTIVE mode is contained (the Affinity Personas pattern) — inactive ones
 *    stay bare, because the icon is already doing the work.
 * 2. THE READOUTS ARE ONE INSTRUMENT, NOT FIVE. Host and quota live in a single
 *    well divided by hairlines, so the eye parses one object with internal
 *    structure rather than five loose numbers.
 * 3. THE BAR IS THE CHASSIS. Its surface drops to `--bar` — the darkest tier —
 *    so every column below reads as carved INTO it rather than stacked beside
 *    it. That is The Carved Rule applied to the shell itself.
 *
 * The centre is deliberately empty in Work: every Work-scoped action already has
 * a correct home one level down. See ToolbarSlot for the rule that governs it.
 */
export function TopBar(): JSX.Element {
  const { view, setView } = useStoreSelector(
    (s) => ({ view: s.view, setView: s.setView }),
    shallowEqual,
  )
  const issues = useReplicaIssues()
  const workflowsEnabled = useFeature('workflows')
  const specsEnabled = useFeature('specs')
  const automationsEnabled = useFeature('automations')
  const slotFilled = useToolbarSlotFilled()

  // Proposals are a curation inbox, distinct from agents asking questions. [spec:SP-6144]
  const proposedCount = issues.filter(
    (issue) => !issue.archived && !issue.deletedAt && issue.stage === 'proposed',
  ).length
  const desktopBridge = nativeDesktopBridge()
  const dragRegion = desktopBridge ? { 'data-tauri-drag-region': true } : undefined

  return (
    <header className="desktop-topbar" data-testid="desktop-topbar" {...dragRegion}>
      <span className="desktop-topbar-logo" {...dragRegion}>
        <PodiumLogo height={19} className="flex-none" />
      </span>
      <nav className="topbar-well desktop-topbar-nav" aria-label="Primary">
        <ModeTab
          label="Work"
          target="workspace"
          view={view}
          onSelect={setView}
          icon={LayoutPanelLeft}
        />
        <ModeTab
          label="Tasks"
          target="issues"
          view={view}
          onSelect={setView}
          icon={SquareKanban}
          badge={proposedCount}
        />
        {workflowsEnabled && (
          <ModeTab
            label="Workflows"
            target="workflows"
            view={view}
            onSelect={setView}
            icon={Workflow}
          />
        )}
        {specsEnabled && (
          <ModeTab label="Specs" target="specs" view={view} onSelect={setView} icon={FileText} />
        )}
        {automationsEnabled && (
          <ModeTab
            label="Automations"
            target="automations"
            view={view}
            onSelect={setView}
            icon={CalendarClock}
          />
        )}
      </nav>
      {/* The rule that ends the mode zone. Present only when a mode is claiming
          the slot, so Work's empty centre never leaves a divider pointing at
          nothing. */}
      {slotFilled && <span className="topbar-seam" aria-hidden="true" />}
      <ToolbarSlotTarget className="desktop-topbar-slot" />
      <span className="desktop-topbar-gap" {...dragRegion} />
      <HeaderHostIndicators />
      <span className="topbar-seam topbar-seam-static" aria-hidden="true" />
      <div className="desktop-topbar-utilities">
        <UtilityNavItem
          label="Usage & analytics"
          target="usage"
          view={view}
          onSelect={setView}
          icon={<BarChart3 size={14} aria-hidden="true" />}
        />
        <UtilityNavItem
          label="Settings"
          target="settings"
          view={view}
          onSelect={setView}
          icon={<Settings size={14} aria-hidden="true" />}
        />
      </div>
      {desktopBridge && desktopBridge.platform !== 'macos' && (
        <NativeWindowControls bridge={desktopBridge} />
      )}
    </header>
  )
}

function UtilityNavItem({
  label,
  target,
  view,
  onSelect,
  icon,
}: {
  label: string
  target: MainView
  view: MainView
  onSelect: (view: MainView) => void
  icon: JSX.Element
}): JSX.Element {
  const active = view === target
  return (
    <button
      data-pressable
      type="button"
      onClick={() => onSelect(target)}
      aria-current={active ? 'page' : undefined}
      aria-label={label}
      title={label}
      className={cn(
        'flex size-7 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground',
        active && 'bg-secondary text-foreground',
      )}
    >
      {icon}
    </button>
  )
}

function NativeWindowControls({ bridge }: { bridge: NativeDesktopBridge }): JSX.Element {
  const run = (action: () => Promise<void>): void => {
    void action().catch((error: unknown) => {
      console.error('[podium-desktop] window action failed', error)
    })
  }

  return (
    <div className="native-window-controls" role="group" aria-label="Window controls">
      <button
        data-pressable
        type="button"
        className="native-window-control"
        aria-label="Minimize window"
        title="Minimize"
        onClick={() => run(bridge.minimize)}
      >
        <Minus size={15} strokeWidth={1.5} aria-hidden="true" />
      </button>
      <button
        data-pressable
        type="button"
        className="native-window-control"
        aria-label="Maximize window"
        title="Maximize or restore"
        onClick={() => run(bridge.toggleMaximize)}
      >
        <Square size={11} strokeWidth={1.5} aria-hidden="true" />
      </button>
      <button
        data-pressable
        type="button"
        className="native-window-control native-window-control-close"
        aria-label="Close window"
        title="Close"
        onClick={() => run(bridge.close)}
      >
        <X size={15} strokeWidth={1.5} aria-hidden="true" />
      </button>
    </div>
  )
}

/**
 * One mode. Inactive is a bare glyph + label; active gains the chip surface,
 * the Border Strong ring and the 1px issue-neutral yellow inset line the pane
 * tabs already use for "this is the one you are in". Yellow appears as a
 * hairline rather than a fill so The Signal Rule survives — a filled brand pill
 * would sit lit on screen permanently while nothing is being asked of you.
 */
function ModeTab({
  label,
  target,
  view,
  onSelect,
  icon: Icon,
  badge,
}: {
  label: string
  target: MainView
  view: MainView
  onSelect: (view: MainView) => void
  icon: ComponentType<{ size?: number; 'aria-hidden'?: boolean; className?: string }>
  badge?: number
}): JSX.Element {
  const active = view === target
  return (
    <button
      data-pressable
      type="button"
      // Keyed on the DESTINATION, not the label: "Issues" became "Tasks" in the
      // POD-650 naming trial and took the browser lane's nav selectors with it.
      data-testid={`topbar-nav-${target}`}
      onClick={() => onSelect(target)}
      aria-current={active ? 'page' : undefined}
      // The label is hidden under the narrow breakpoint; the accessible name and
      // the tooltip must survive it.
      aria-label={label}
      title={label}
      className="topbar-mode"
      data-active={active ? 'true' : undefined}
    >
      <Icon size={13} aria-hidden={true} className="flex-none" />
      <span>{label}</span>
      {!!badge && <span className="topbar-mode-badge">{badge}</span>}
    </button>
  )
}
