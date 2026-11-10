import type { SettingsPage } from '@podium/client-core/ui-state'
import { ArrowLeft, ChevronRight, Search, Users } from 'lucide-react'
import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react'
import { createPortal } from 'react-dom'
import { AppSheet } from '@/app/AppSheet'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { cn } from '@/lib/utils'
import { AdminViewerError } from './AdminViewerError'
import type { AdminViewer } from './admin-viewer'
import {
  SETTINGS_GROUPS,
  type SettingsSearchResult,
  searchSettings,
  settingsPage,
  settingsSectionId,
} from './page-definitions'
import { visibleSettingsGroups } from './surfaces'

interface Takeover {
  title: string
  description?: ReactNode
  content: ReactNode
}
interface FrameActions {
  actionSlot: HTMLDivElement | null
  openTakeover: (flow: Takeover) => void
  closeTakeover: () => void
}
const FrameContext = createContext<FrameActions | null>(null)

/** Page tasks open details/flows in the pane, with the rail and sheet intact. */
export function useSettingsFrame(): FrameActions {
  const frame = useContext(FrameContext)
  if (!frame) throw new Error('Settings page must be inside SettingsFrame')
  return frame
}

/** Place a real page action (Add machine, Add project, Invite) in its header.
 * A portal keeps the handler and form state owned by the page. */
export function SettingsPageActions({ children }: { children: ReactNode }) {
  const { actionSlot } = useSettingsFrame()
  return actionSlot ? createPortal(children, actionSlot) : null
}

export function SettingsTakeover({
  page,
  title,
  description,
  onBack,
  children,
}: {
  page: SettingsPage
  title: string
  description?: ReactNode
  onBack: () => void
  children: ReactNode
}) {
  const heading = useRef<HTMLHeadingElement | null>(null)
  useEffect(() => heading.current?.focus({ preventScroll: true }), [])
  return (
    <section
      aria-label={title}
      className="settings-takeover settings-section-enter"
      onKeyDown={(event) => {
        if (event.key !== 'Escape' || event.defaultPrevented) return
        event.preventDefault()
        event.stopPropagation()
        onBack()
      }}
    >
      <Button
        type="button"
        variant="ghost"
        size="sm"
        className="settings-flow-back"
        onClick={onBack}
      >
        <ArrowLeft size={14} aria-hidden="true" />
        {settingsPage(page).label}
      </Button>
      <header className="settings-page-header">
        <div>
          <h3 ref={heading} tabIndex={-1} className="settings-page-title">
            {title}
          </h3>
          {description && <p className="settings-prose mt-1.5">{description}</p>}
        </div>
      </header>
      {children}
    </section>
  )
}

function isTyping(target: EventTarget | null): boolean {
  return (
    target instanceof HTMLElement &&
    (target.matches('input, textarea, select') || target.isContentEditable)
  )
}

export function SettingsFrame({
  page,
  onPageChange,
  onClose,
  viewer,
  toolbar,
  footer,
  children,
}: {
  page: SettingsPage
  onPageChange: (page: SettingsPage | null) => void
  onClose: () => void
  viewer: AdminViewer
  toolbar?: ReactNode
  footer?: ReactNode
  children: ReactNode
}) {
  const definition = settingsPage(page)
  const groups = visibleSettingsGroups(SETTINGS_GROUPS, viewer.sections)
  const pages = groups.flatMap((group) => group.tabs)
  const [query, setQuery] = useState('')
  const results = searchSettings(query, pages)
  const searching = query.trim().length > 0
  const [selectedResult, setSelectedResult] = useState(0)
  const [phonePage, setPhonePage] = useState(() =>
    // /settings starts at the rail on a phone; a deep link starts at its page.
    /\/settings\/[^/]+\/?$/.test(window.location.pathname),
  )
  const [flow, setFlow] = useState<(Takeover & { page: SettingsPage }) | null>(null)
  const takeover = flow?.page === page ? flow : null
  const [actionSlot, setActionSlot] = useState<HTMLDivElement | null>(null)
  const [jump, setJump] = useState<SettingsSearchResult | null>(null)
  const filterRef = useRef<HTMLInputElement | null>(null)
  const scrollRef = useRef<HTMLDivElement | null>(null)
  const pageRef = useRef<HTMLHeadingElement | null>(null)
  const openTakeover = useCallback(
    (next: Takeover) => {
      setFlow({ ...next, page })
      setQuery('')
      setPhonePage(true)
    },
    [page],
  )
  const closeTakeover = useCallback(() => {
    setFlow(null)
    requestAnimationFrame(() => pageRef.current?.focus({ preventScroll: true }))
  }, [])
  const actions = useMemo(
    () => ({ actionSlot, openTakeover, closeTakeover }),
    [actionSlot, openTakeover, closeTakeover],
  )

  const openPage = (next: SettingsPage) => {
    setQuery('')
    setFlow(null)
    setPhonePage(true)
    onPageChange(next)
  }
  const openResult = (result: SettingsSearchResult) => {
    setJump(result)
    openPage(result.page.key)
  }
  const showRail = () => {
    setPhonePage(false)
    setQuery('')
    setFlow(null)
    onPageChange(null)
  }

  // A route change, including browser Back/Forward, drops a flow from the old page.
  // biome-ignore lint/correctness/useExhaustiveDependencies: navigation resets the old page’s flow and scroll.
  useEffect(() => {
    setFlow(null)
    scrollRef.current?.scrollTo?.({ top: 0 })
  }, [page])

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (
        event.key === '/' &&
        !event.metaKey &&
        !event.ctrlKey &&
        !event.altKey &&
        !isTyping(event.target)
      ) {
        event.preventDefault()
        // The phone search lives on the rail, so reveal it before taking focus.
        setPhonePage(false)
        requestAnimationFrame(() => filterRef.current?.focus())
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  // Lazy section chunks can land after navigation. Observe only this pane until
  // its addressed row exists, then disconnect; no polling or global DOM scan.
  useEffect(() => {
    if (!jump || jump.page.key !== page) return
    const scroll = scrollRef.current
    if (!scroll) return
    let frame = 0
    const reveal = () => {
      const target = document.getElementById(jump.targetId)
      if (!target || !scroll.contains(target)) return false
      frame = requestAnimationFrame(() => {
        target.scrollIntoView?.({ block: 'center', behavior: 'instant' })
        target.focus({ preventScroll: true })
        target.classList.remove('settings-search-highlight')
        // Restart the one-shot highlight even if the same result is chosen twice.
        void target.offsetWidth
        target.classList.add('settings-search-highlight')
        target.addEventListener(
          'animationend',
          () => target.classList.remove('settings-search-highlight'),
          { once: true },
        )
        setJump(null)
      })
      return true
    }
    if (reveal()) return () => cancelAnimationFrame(frame)
    const observer = new MutationObserver(() => {
      if (reveal()) observer.disconnect()
    })
    observer.observe(scroll, { childList: true, subtree: true })
    // A conditional row may be unavailable (for example an effort control for
    // a harness without effort). Once its section is ready, land on that section.
    const section = document.getElementById(settingsSectionId(jump.section))
    if (section && section.children.length > 0) {
      frame = requestAnimationFrame(() => {
        if (!reveal()) {
          section.scrollIntoView?.({ block: 'center' })
          section.focus({ preventScroll: true })
          setJump(null)
        }
      })
    }
    return () => {
      observer.disconnect()
      cancelAnimationFrame(frame)
    }
  }, [jump, page])

  const sheetTitle = (
    <span className="settings-sheet-title">
      <button
        type="button"
        className="settings-mobile-back"
        aria-label="Back to settings"
        onClick={showRail}
      >
        <ArrowLeft size={16} aria-hidden="true" />
      </button>
      <span>Settings</span>
      <span className="settings-sheet-crumb" aria-hidden="true">
        / {searching ? 'Search' : (takeover?.title ?? definition.label)}
      </span>
    </span>
  )

  return (
    <FrameContext.Provider value={actions}>
      <AppSheet
        label="Settings"
        title={sheetTitle}
        testId="settings-sheet"
        onClose={onClose}
        toolbar={toolbar}
        className={cn(
          'app-sheet-settings',
          phonePage && 'settings-in-page',
          searching && 'settings-searching',
        )}
      >
        <section
          aria-label="Settings content"
          className="settings-panes"
          onKeyDown={(event) => {
            if (event.key !== 'Escape' || event.defaultPrevented) return
            if (takeover) {
              event.preventDefault()
              event.stopPropagation()
              closeTakeover()
            } else if (searching) {
              event.preventDefault()
              event.stopPropagation()
              setQuery('')
              filterRef.current?.blur()
            }
          }}
        >
          <nav
            className="settings-rail [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
            aria-label="Settings sections"
            aria-busy={viewer.status === 'loading'}
          >
            <div className="settings-search-field">
              <Search size={13} aria-hidden="true" />
              <Input
                ref={filterRef}
                type="search"
                value={query}
                aria-label="Search settings"
                placeholder="Search settings"
                onChange={(event) => {
                  setQuery(event.target.value)
                  setSelectedResult(0)
                }}
                onKeyDown={(event) => {
                  if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
                    event.preventDefault()
                    setSelectedResult((current) =>
                      Math.max(
                        0,
                        Math.min(
                          results.length - 1,
                          current + (event.key === 'ArrowDown' ? 1 : -1),
                        ),
                      ),
                    )
                  } else if (event.key === 'Enter' && results[selectedResult]) {
                    event.preventDefault()
                    openResult(results[selectedResult]!)
                  } else if (event.key === 'Escape') {
                    event.preventDefault()
                    event.stopPropagation()
                    setQuery('')
                    event.currentTarget.blur()
                  }
                }}
              />
              {!query && <kbd>/</kbd>}
            </div>
            {groups.map((group) => (
              <div className="settings-rail-section" key={group.surface}>
                <div className="settings-rail-heading">
                  <span className="settings-eyebrow settings-rail-group">{group.label}</span>
                  {group.surface === 'workspace' && (
                    <span className="settings-rail-hint">Everyone</span>
                  )}
                </div>
                {viewer.status === 'loading' ? (
                  <div
                    className="settings-rail-skeleton"
                    aria-label={`Loading ${group.label.toLowerCase()} pages`}
                    role="status"
                  >
                    {(group.surface === 'personal'
                      ? [0, 1, 2, 3, 4]
                      : [0, 1, 2, 3, 4, 5, 6, 7]
                    ).map((i) => (
                      <div key={i} />
                    ))}
                  </div>
                ) : (
                  group.tabs.map((entry) => {
                    const Icon = entry.icon
                    return (
                      <button
                        type="button"
                        data-pressable
                        key={entry.key}
                        className="settings-rail-item"
                        aria-current={
                          !searching && !takeover && entry.key === page ? 'page' : undefined
                        }
                        onClick={() => openPage(entry.key)}
                      >
                        <Icon size={14} aria-hidden="true" />
                        <span>{entry.label}</span>
                      </button>
                    )
                  })
                )}
              </div>
            ))}
            <AdminViewerError viewer={viewer} />
          </nav>
          <div className="settings-pane">
            <div ref={scrollRef} className="settings-pane-scroll">
              <div className="settings-measure">
                {searching && <div className="settings-search-results">{renderResults()}</div>}
                {takeover && (
                  <SettingsTakeover
                    page={page}
                    title={takeover.title}
                    description={takeover.description}
                    onBack={closeTakeover}
                  >
                    {takeover.content}
                  </SettingsTakeover>
                )}
                <div
                  hidden={searching || Boolean(takeover)}
                  className="settings-page-content settings-section-enter"
                  key={page}
                >
                  <header className="settings-page-header">
                    <div>
                      <h3 ref={pageRef} tabIndex={-1} className="settings-page-title">
                        {definition.label}
                        {definition.group === 'workspace' && (
                          <span
                            className="settings-scope-tag"
                            title="Changes here apply to everyone in this workspace"
                          >
                            <Users size={11} aria-hidden="true" />
                            Everyone
                          </span>
                        )}
                      </h3>
                      <p className="settings-prose mt-1.5">{definition.description}</p>
                    </div>
                    <div ref={setActionSlot} className="settings-page-actions" />
                  </header>
                  {children}
                </div>
              </div>
            </div>
            {footer}
          </div>
        </section>
      </AppSheet>
    </FrameContext.Provider>
  )

  function renderResults() {
    return (
      <>
        <header className="settings-page-header">
          <div>
            <h3 className="settings-page-title">
              {results.length ? 'Results' : `No settings match “${query.trim()}”`}
            </h3>
            <p className="settings-prose mt-1.5" role="status">
              {results.length
                ? `${results.length} ${results.length === 1 ? 'match' : 'matches'} for “${query.trim()}”. ↑↓ to move, ↵ to open`
                : 'Try a broader word, like “model”, “phone”, “branch” or “password”.'}
            </p>
          </div>
        </header>
        <div className="settings-results-list">
          {results.map((result, index) => {
            const Icon = result.page.icon
            return (
              <button
                type="button"
                key={`${result.page.key}-${result.label}`}
                className={cn(
                  'settings-result',
                  index === selectedResult && 'settings-result-selected',
                )}
                onClick={() => openResult(result)}
              >
                <Icon size={16} aria-hidden="true" />
                <span>
                  <span className="settings-result-label">{result.label}</span>
                  <span className="settings-result-path">{result.page.label}</span>
                </span>
                <ChevronRight size={14} aria-hidden="true" />
              </button>
            )
          })}
        </div>
      </>
    )
  }
}
