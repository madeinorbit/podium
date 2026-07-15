import { shallowEqual } from '@podium/client-core/store'
import type { JSX } from 'react'
import { HeaderHostIndicators } from '@/features/machines/HostIndicators'
import { PodiumLogo } from '@/lib/icons/PodiumLogo'
import { cn } from '@/lib/utils'
import { type MainView, useStoreSelector } from './store'

/**
 * The desktop 44px command header per the handoff v2 desktop anatomy
 * (.design/specs/shell-layout.md §2.1): logo · text nav (Home with the amber
 * waiting badge · Issues · Workflows · Specs · Automations) · machine + quota chips
 * right-aligned. The icon-cell header with issue-context dropdown and “+”
 * belongs to the MOBILE shell (MobileApp.tsx), not here.
 */
export function TopBar(): JSX.Element {
  const { view, setView, issues } = useStoreSelector(
    (s) => ({ view: s.view, setView: s.setView, issues: s.issues }),
    shallowEqual,
  )

  const waitingCount = issues.filter(
    (issue) => !issue.archived && !issue.deletedAt && issue.needsHuman,
  ).length

  return (
    <header className="desktop-topbar" data-testid="desktop-topbar">
      <PodiumLogo className="flex-none" />
      <nav className="ml-[10px] inline-flex flex-none items-center gap-0.5" aria-label="Primary">
        <NavItem label="Home" target="home" view={view} onSelect={setView} badge={waitingCount} />
        <NavItem label="Issues" target="issues" view={view} onSelect={setView} />
        <NavItem label="Workflows" target="workflows" view={view} onSelect={setView} />
        <NavItem label="Specs" target="specs" view={view} onSelect={setView} />
        <NavItem label="Automations" target="automations" view={view} onSelect={setView} />
      </nav>
      <div className="ml-auto min-w-0 overflow-hidden">
        <HeaderHostIndicators />
      </div>
    </header>
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
