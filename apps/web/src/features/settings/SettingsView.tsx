import { shallowEqual } from '@podium/client-core/store'
import type { HostMetricsWire } from '@podium/protocol'
import { DEFAULT_SETTINGS, type PodiumSettings } from '@podium/runtime'
import type { JSX } from 'react'
import { useEffect, useRef, useState } from 'react'
import { useStoreSelector } from '@/app/store'
import type { Trpc } from '@/app/trpc'
import { Button } from '@/components/ui/button'
import { invalidateFeatures, useFeature } from '@/lib/use-feature'
import { cn } from '@/lib/utils'
import { MachinesPanel } from './MachinesPanel'
import { AccountsSection } from './sections/accounts'
import { AppearanceSection } from './sections/appearance'
import { ExperimentalSection } from './sections/experimental'
import { HibernationSection } from './sections/hibernation'
import { IntegrationsSection } from './sections/integrations'
import { KeysSection } from './sections/keys'
import { NetworkSection } from './sections/network'
import { NotificationsSection, type TelegramSetupState } from './sections/notifications'
import { PrivacySection } from './sections/privacy'
import { ReposSection } from './sections/repos'
import { LoginPasswordSection } from './sections/security'
import { SessionsSection } from './sections/sessions'
import type { AccountView } from './sections/shared'
import { SuperagentSection } from './sections/superagent'
import { UpdatesSection } from './sections/updates'
import { WorkflowSection } from './sections/workflow'
import { WorkLlmSection } from './sections/workllm'

export type SettingsTab =
  | 'appearance'
  | 'accounts'
  | 'sessions'
  | 'superagent'
  | 'workllm'
  | 'keys'
  | 'hibernation'
  | 'notifications'
  | 'workflow'
  | 'integrations'
  | 'network'
  | 'repos'
  | 'machines'
  | 'security'
  | 'privacy'
  | 'updates'
  | 'experimental'

/** The grouped IA (POD-127): four named groups replace the flat 17-item list.
 *  Routes (/settings/:tab) are unchanged — this only regroups the nav. */
export const SETTINGS_GROUPS: {
  label: string
  tabs: { key: SettingsTab; label: string }[]
}[] = [
  {
    label: 'Agents',
    tabs: [
      { key: 'sessions', label: 'New sessions' },
      { key: 'superagent', label: 'Superagent' },
      { key: 'workllm', label: 'Background LLM' },
      { key: 'workflow', label: 'Workflow' },
      { key: 'hibernation', label: 'Hibernation' },
    ],
  },
  {
    label: 'Connections',
    tabs: [
      { key: 'accounts', label: 'Accounts' },
      { key: 'keys', label: 'API keys' },
      { key: 'notifications', label: 'Notifications' },
      { key: 'integrations', label: 'Integrations' },
    ],
  },
  {
    label: 'Workspace',
    tabs: [
      { key: 'repos', label: 'Repos' },
      { key: 'machines', label: 'Machines' },
      { key: 'network', label: 'Network' },
    ],
  },
  {
    label: 'Instance',
    tabs: [
      { key: 'appearance', label: 'Appearance' },
      { key: 'security', label: 'Security' },
      // Next to Security, not buried: the opt-out has to be findable by someone
      // looking for it, which is the whole promise the prompt made [spec:SP-f933].
      { key: 'privacy', label: 'Privacy' },
      { key: 'updates', label: 'Updates' },
      { key: 'experimental', label: 'Experimental' },
    ],
  },
]

export const SETTINGS_TABS: { key: SettingsTab; label: string }[] = SETTINGS_GROUPS.flatMap(
  (g) => g.tabs,
)

/** Tabs that edit the shared blob and ride the dirty-bar Save; the rest
 *  self-persist and apply instantly, so the bar never shows there. */
const BLOB_TABS: ReadonlySet<SettingsTab> = new Set([
  'sessions',
  'superagent',
  'workllm',
  'keys',
  'hibernation',
  'notifications',
  'workflow',
  'integrations',
  'experimental',
])

/** Everything a section can pull from the view: the loaded blob, the local
 *  patch, the accounts list, the Telegram flow state, and the store trpc. */
interface SectionContext {
  settings: PodiumSettings
  accounts: AccountView[]
  patch: (p: Partial<PodiumSettings>) => void
  trpc: Trpc
  telegramSetup: TelegramSetupState
  telegramSetupNow: number
  hostMetrics: HostMetricsWire[]
  startTelegramSetup: () => void
  resetTelegramSetup: () => void
  /** Replace the local blob with DEFAULT_SETTINGS (still needs Save). */
  resetToDefaults: () => void
}

/** The tab -> section lookup (P5d, issue #264 — replaces the JSX ladder). Most
 *  sections edit the shared blob via `patch`; the self-persisting ones
 *  (appearance, accounts, network, machines, security, updates) pull what they
 *  need from the store hook themselves. */
const SECTION_VIEWS: Record<SettingsTab, (ctx: SectionContext) => JSX.Element> = {
  appearance: () => <AppearanceSection />,
  accounts: () => <AccountsSection />,
  sessions: ({ settings, accounts, patch }) => (
    <SessionsSection settings={settings} accounts={accounts} patch={patch} />
  ),
  superagent: ({ settings, accounts, patch }) => (
    <SuperagentSection settings={settings} accounts={accounts} patch={patch} />
  ),
  workllm: ({ settings, accounts, patch }) => (
    <WorkLlmSection settings={settings} accounts={accounts} patch={patch} />
  ),
  keys: ({ settings, patch }) => <KeysSection settings={settings} patch={patch} />,
  hibernation: ({ settings, patch, hostMetrics }) => (
    <HibernationSection settings={settings} patch={patch} hostMetrics={hostMetrics} />
  ),
  notifications: (ctx) => (
    <NotificationsSection
      settings={ctx.settings}
      patch={ctx.patch}
      telegramSetup={ctx.telegramSetup}
      telegramSetupNow={ctx.telegramSetupNow}
      onStartTelegramSetup={ctx.startTelegramSetup}
      onResetTelegramSetup={ctx.resetTelegramSetup}
    />
  ),
  workflow: ({ settings, patch }) => <WorkflowSection settings={settings} patch={patch} />,
  integrations: ({ settings, patch }) => <IntegrationsSection settings={settings} patch={patch} />,
  network: () => <NetworkSection />,
  repos: () => <ReposSection />,
  machines: () => <MachinesPanel />,
  security: ({ trpc }) => <LoginPasswordSection trpc={trpc} />,
  // Self-persisting (config.json, not the settings blob) — see privacy.tsx.
  privacy: () => <PrivacySection />,
  updates: () => <UpdatesSection />,
  experimental: ({ settings, patch, resetToDefaults }) => (
    <ExperimentalSection settings={settings} patch={patch} onReset={resetToDefaults} />
  ),
}

/**
 * Settings — a full main-content surface (not a modal), split into sections via a
 * side nav. Loads the whole blob, edits a local copy, saves it whole — no
 * per-field mutations, so the form can never half-apply even though only one
 * section is on screen at a time. Each tab's section lives in ./sections/<tab>
 * and renders through the SECTION_VIEWS lookup. The Telegram connect flow's
 * state (and its poll) stays here so it survives switching tabs.
 */
export function SettingsView(): JSX.Element {
  const { trpc, setView, settingsTab, setSettingsTab, hostMetrics } = useStoreSelector(
    (s) => ({
      trpc: s.trpc,
      setView: s.setView,
      settingsTab: s.settingsTab,
      setSettingsTab: s.setSettingsTab,
      hostMetrics: s.hostMetrics,
    }),
    shallowEqual,
  )
  const notificationsEnabled = useFeature('notifications')
  const settingsTabs = SETTINGS_TABS.filter(
    (tab) => tab.key !== 'notifications' || notificationsEnabled,
  )
  const [settings, setSettings] = useState<PodiumSettings | null>(null)
  // The last server-confirmed blob: the dirty bar shows iff `settings` diverges
  // from it, and Discard restores it (POD-127 F4).
  const [lastSaved, setLastSaved] = useState<PodiumSettings | null>(null)
  const [accounts, setAccounts] = useState<AccountView[]>([])
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [savedAt, setSavedAt] = useState(0)
  const [filter, setFilter] = useState('')
  const [telegramSetup, setTelegramSetup] = useState<TelegramSetupState>({ status: 'idle' })
  const [telegramSetupNow, setTelegramSetupNow] = useState(() => Date.now())
  // The tab is the URL (/settings/:tab, issue #15 Phase 4): deep links (global
  // search, the Machines panel's "Change URL") land directly on their tab, tab
  // clicks push history entries (setSettingsTab), and back/forward moves
  // between visited tabs. A plain /settings shows the default tab.
  const tab: SettingsTab =
    settingsTab && settingsTabs.some((s) => s.key === settingsTab)
      ? (settingsTab as SettingsTab)
      : 'sessions'

  useEffect(() => {
    let cancelled = false
    trpc.settings.get
      .query()
      .then((s) => {
        if (!cancelled) {
          setSettings(s)
          setLastSaved(s)
        }
      })
      .catch((e) => {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e))
      })
    trpc.accounts.list
      .query()
      .then((a) => {
        if (!cancelled) setAccounts(a as AccountView[])
      })
      .catch(() => {})
    return () => {
      cancelled = true
    }
  }, [trpc])

  useEffect(() => {
    if (telegramSetup.status !== 'polling') return
    setTelegramSetupNow(Date.now())
    const id = window.setInterval(() => setTelegramSetupNow(Date.now()), 1000)
    return () => window.clearInterval(id)
  }, [telegramSetup.status])

  const activeTelegramSetup = telegramSetup.status === 'polling' ? telegramSetup : null
  const activeTelegramSetupId = activeTelegramSetup?.setupId
  const activeTelegramSetupExpiresAt = activeTelegramSetup?.expiresAt

  useEffect(() => {
    if (!activeTelegramSetupId || !activeTelegramSetupExpiresAt) return
    let cancelled = false
    let inFlight = false
    const poll = async () => {
      if (inFlight) return
      if (Date.now() > Date.parse(activeTelegramSetupExpiresAt)) {
        setTelegramSetup({ status: 'expired' })
        return
      }
      inFlight = true
      try {
        const result = await trpc.settings.telegramSetupPoll.mutate({
          setupId: activeTelegramSetupId,
        })
        if (cancelled) return
        if (result.status === 'connected') {
          setSettings(result.settings)
          setLastSaved(result.settings)
          setSavedAt(Date.now())
          setTelegramSetup({
            status: 'connected',
            chatId: result.chatId,
            chatType: result.chatType,
            ...(result.chatLabel ? { chatLabel: result.chatLabel } : {}),
          })
        } else if (result.status === 'expired') {
          setTelegramSetup({ status: 'expired' })
        } else {
          setTelegramSetup((current) =>
            current.status === 'polling' && current.setupId === activeTelegramSetupId
              ? { ...current, error: undefined }
              : current,
          )
        }
      } catch (e) {
        if (!cancelled) {
          const message = e instanceof Error ? e.message : String(e)
          setTelegramSetup((current) =>
            current.status === 'polling' && current.setupId === activeTelegramSetupId
              ? { ...current, error: message }
              : current,
          )
        }
      } finally {
        inFlight = false
      }
    }
    void poll()
    const id = window.setInterval(() => void poll(), 2500)
    return () => {
      cancelled = true
      window.clearInterval(id)
    }
  }, [activeTelegramSetupId, activeTelegramSetupExpiresAt, trpc])

  const startTelegramSetup = async () => {
    if (!settings) return
    const token = settings.notifications.telegramBotToken.trim()
    if (!token) {
      setTelegramSetup({ status: 'failed', message: 'Paste a Telegram bot token first.' })
      return
    }

    setError(null)
    setTelegramSetup({ status: 'starting' })
    try {
      const saved = await trpc.settings.set.mutate(settings)
      setSettings(saved)
      setLastSaved(saved)
      const setup = await trpc.settings.telegramSetupStart.mutate()
      setTelegramSetup({ status: 'polling', ...setup })
      setTelegramSetupNow(Date.now())
    } catch (e) {
      setTelegramSetup({ status: 'failed', message: e instanceof Error ? e.message : String(e) })
    }
  }

  const save = async () => {
    if (!settings) return
    setSaving(true)
    setError(null)
    try {
      const saved = await trpc.settings.set.mutate(settings)
      setSettings(saved)
      setLastSaved(saved)
      // Refresh feature gates so useFeature sees the saved experimental toggles
      // [spec:SP-f4b9].
      invalidateFeatures(trpc)
      setSavedAt(Date.now())
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setSaving(false)
    }
  }

  const patch = (p: Partial<PodiumSettings>) => setSettings((s) => (s ? { ...s, ...p } : s))
  const dirty =
    settings !== null && lastSaved !== null && JSON.stringify(settings) !== JSON.stringify(lastSaved)
  // The saved flash keeps the bar visible for a beat after a successful save.
  const [, forceTick] = useState(0)
  const savedFlash = savedAt > 0 && Date.now() - savedAt < 1500
  useEffect(() => {
    if (!savedFlash) return
    const id = window.setTimeout(() => forceTick((n) => n + 1), 1600)
    return () => window.clearTimeout(id)
  }, [savedFlash])
  const showBar = BLOB_TABS.has(tab) && (dirty || saving || savedFlash || Boolean(error))
  const discard = () => {
    setSettings(lastSaved)
    setError(null)
  }

  const filterRef = useRef<HTMLInputElement | null>(null)
  const query = filter.trim().toLowerCase()
  const visibleGroups = SETTINGS_GROUPS.map((g) => ({
    label: g.label,
    tabs: g.tabs.filter(
      (t) =>
        (t.key !== 'notifications' || notificationsEnabled) &&
        (query === '' || t.label.toLowerCase().includes(query)),
    ),
  })).filter((g) => g.tabs.length > 0)

  // "/" focuses the nav filter; ⌘S saves when the dirty bar is up.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const el = document.activeElement
      const typing =
        el instanceof HTMLElement &&
        (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable)
      if (e.key === '/' && !typing) {
        e.preventDefault()
        filterRef.current?.focus()
      } else if ((e.metaKey || e.ctrlKey) && e.key === 's') {
        e.preventDefault()
        if (dirty && !saving && BLOB_TABS.has(tab)) void save()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  })

  return (
    <section className="flex min-w-0 flex-1 flex-col overflow-hidden" aria-label="Settings">
      <div className="flex items-center justify-between border-border border-b px-4 py-3 md:px-[22px] md:py-3.5">
        <h2 className="font-medium text-base text-foreground">Settings</h2>
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          title="Close settings"
          onClick={() => setView('issues')}
        >
          ✕
        </Button>
      </div>
      {error && !settings && (
        <div className="border-border border-b px-4 py-2 text-destructive text-xs">{error}</div>
      )}
      <div className="relative flex min-h-0 flex-1 flex-col md:flex-row">
        <nav
          className="flex flex-row gap-1 overflow-x-auto border-border border-b p-2 md:w-[216px] md:flex-none md:flex-col md:gap-0 md:overflow-y-auto md:border-hairline-soft md:border-r md:border-b-0 md:bg-rail md:p-3 md:px-2.5 md:shadow-[inset_-3px_0_6px_-3px_rgb(0_0_0_/_0.55)] [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
          aria-label="Settings sections"
        >
          <div className="relative mb-2 hidden md:block">
            <input
              ref={filterRef}
              type="text"
              value={filter}
              placeholder="Find a setting"
              className="h-7 w-full rounded-md border border-hairline-soft bg-background px-2.5 text-[11.5px] text-foreground placeholder:text-text-faint focus:outline-none focus:ring-1 focus:ring-ring/40"
              onChange={(e) => setFilter(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  const first = visibleGroups[0]?.tabs[0]
                  if (first) setSettingsTab(first.key)
                } else if (e.key === 'Escape') {
                  setFilter('')
                  e.currentTarget.blur()
                  e.stopPropagation()
                }
              }}
            />
            {filter === '' && (
              <kbd className="-translate-y-1/2 pointer-events-none absolute top-1/2 right-2 rounded border border-hairline-soft px-1 font-mono text-[9px] text-text-faint">
                /
              </kbd>
            )}
          </div>
          {visibleGroups.map((g) => (
            <div key={g.label} className="contents md:block">
              <div className="mt-3 mb-1 hidden px-2 font-medium font-mono text-[8.5px] text-label uppercase tracking-[0.12em] first:mt-1 md:block">
                {g.label}
              </div>
              {g.tabs.map((t) => (
                <button
                  key={t.key}
                  type="button"
                  className={cn(
                    'block w-full cursor-pointer whitespace-nowrap rounded-md px-2.5 py-2 text-left text-[12.5px] text-muted-foreground transition-colors hover:bg-accent/60 hover:text-foreground md:py-[5px]',
                    t.key === tab && 'bg-chip font-medium text-text-strong hover:bg-chip',
                  )}
                  aria-current={t.key === tab}
                  onClick={() => setSettingsTab(t.key)}
                >
                  {t.label}
                </button>
              ))}
            </div>
          ))}
          {query !== '' && visibleGroups.length === 0 && (
            <p className="hidden px-2 pt-1 text-[11.5px] text-text-dim md:block">
              No section matches “{filter.trim()}”.
            </p>
          )}
        </nav>
        <div className="flex-1 overflow-y-auto px-4 py-3 pb-24 md:px-[30px] md:py-4">
          <div className="max-w-[620px]">
            {settings ? (
              SECTION_VIEWS[tab]({
                settings,
                accounts,
                patch,
                trpc,
                telegramSetup,
                telegramSetupNow,
                hostMetrics,
                startTelegramSetup: () => void startTelegramSetup(),
                resetTelegramSetup: () => setTelegramSetup({ status: 'idle' }),
                resetToDefaults: () => setSettings(DEFAULT_SETTINGS),
              })
            ) : (
              <div className="animate-pulse pt-2" aria-hidden="true">
                {[0, 1, 2, 3, 4].map((i) => (
                  <div
                    key={i}
                    className="flex items-center justify-between gap-4 border-hairline-soft/50 border-b py-3.5 last:border-b-0"
                  >
                    <div className="min-w-0 space-y-1.5">
                      <div className="h-3 w-36 rounded bg-chip" />
                      {i % 2 === 0 && <div className="h-2 w-56 max-w-full rounded bg-chip/60" />}
                    </div>
                    <div className="h-7 w-[240px] flex-none rounded-md bg-chip/80" />
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
        <div
          className={cn(
            'absolute inset-x-3 bottom-3 z-10 flex items-center gap-2 rounded-lg border border-border-strong bg-chip py-1.5 pr-1.5 pl-3.5 shadow-[0_14px_34px_rgb(0_0_0_/_0.65),0_2px_8px_rgb(0_0_0_/_0.5)] transition-[transform,opacity] duration-200 ease-out motion-reduce:transition-none md:right-4 md:left-[240px]',
            showBar ? 'translate-y-0 opacity-100' : 'pointer-events-none translate-y-16 opacity-0',
          )}
          aria-hidden={!showBar}
        >
          <span
            className={cn(
              'min-w-0 flex-1 truncate text-[12px]',
              error ? 'text-destructive' : 'text-foreground',
            )}
          >
            {error ? error : dirty || saving ? 'Unsaved changes' : 'Saved ✓'}
          </span>
          {(dirty || error) && (
            <Button type="button" variant="ghost" size="sm" onClick={discard}>
              Discard
            </Button>
          )}
          {(dirty || saving || error) && (
            <Button type="button" size="sm" disabled={saving} onClick={() => void save()}>
              {saving ? 'Saving…' : 'Save changes'}
            </Button>
          )}
        </div>
      </div>
    </section>
  )
}
