import { shallowEqual } from '@podium/client-core/store'
import { Minus, Square, X } from 'lucide-react'
import type { JSX } from 'react'
import { HeaderHostIndicators } from '@/features/machines/HostIndicators'
import { PodiumLogo } from '@/lib/icons/PodiumLogo'
import { type NativeDesktopBridge, nativeDesktopBridge } from '@/lib/nativeDesktop'
import { cn } from '@/lib/utils'
import { type MainView, useStoreSelector } from './store'

/**
 * The desktop 44px command header per the handoff v2 desktop anatomy
 * (.design/specs/shell-layout.md §2.1): logo · text nav (Home with the amber
 * waiting badge · Issues · Workflows · Specs · Automations) · machine + quota chips
 * right-aligned. The icon-cell header with issue-context dropdown and “+”
 * belongs to the MOBILE shell (MobileApp.tsx), not here.
 * [spec:SP-3834] The same header becomes the native app's integrated title bar.
 */
export function TopBar(): JSX.Element {
  const { view, setView, issues } = useStoreSelector(
    (s) => ({ view: s.view, setView: s.setView, issues: s.issues }),
    shallowEqual,
  )

  const waitingCount = issues.filter(
    (issue) => !issue.archived && !issue.deletedAt && issue.needsHuman,
  ).length
  const desktopBridge = nativeDesktopBridge()
  const dragRegion = desktopBridge ? { 'data-tauri-drag-region': true } : undefined

  return (
    <header className="desktop-topbar" data-testid="desktop-topbar" {...dragRegion}>
      <span className="desktop-topbar-logo" {...dragRegion}>
        <PodiumLogo className="flex-none" />
      </span>
      <nav className="ml-[10px] inline-flex flex-none items-center gap-0.5" aria-label="Primary">
        <NavItem label="Home" target="home" view={view} onSelect={setView} badge={waitingCount} />
        <NavItem label="Tasks" target="issues" view={view} onSelect={setView} />
        <NavItem label="Workflows" target="workflows" view={view} onSelect={setView} />
        <NavItem label="Specs" target="specs" view={view} onSelect={setView} />
        <NavItem label="Automations" target="automations" view={view} onSelect={setView} />
      </nav>
      <div className="ml-auto min-w-0 overflow-hidden">
        <HeaderHostIndicators />
      </div>
      {desktopBridge && desktopBridge.platform !== 'macos' && (
        <NativeWindowControls bridge={desktopBridge} />
      )}
    </header>
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
        type="button"
        className="native-window-control"
        aria-label="Minimize window"
        title="Minimize"
        onClick={() => run(bridge.minimize)}
      >
        <Minus size={15} strokeWidth={1.5} aria-hidden="true" />
      </button>
      <button
        type="button"
        className="native-window-control"
        aria-label="Maximize window"
        title="Maximize or restore"
        onClick={() => run(bridge.toggleMaximize)}
      >
        <Square size={11} strokeWidth={1.5} aria-hidden="true" />
      </button>
      <button
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

function NavItem({
  label,
  target,
  view,
  onSelect,
  badge,
}: {
  label: string
  target: MainView
  view: MainView
  onSelect: (view: MainView) => void
  badge?: number
}): JSX.Element {
  const active = view === target
  return (
    <button
      type="button"
      onClick={() => onSelect(target)}
      aria-current={active ? 'page' : undefined}
      className={cn(
        'inline-flex items-center gap-1.5 rounded-[6px] px-3 py-1 text-[11.5px] text-muted-foreground hover:text-foreground',
        active && 'px-2.5 font-semibold text-[var(--text-strong)]',
      )}
    >
      {label}
      {!!badge && (
        <span className="rounded-full bg-secondary px-1.5 text-[9.5px] text-[var(--attention)]">
          {badge}
        </span>
      )}
    </button>
  )
}
