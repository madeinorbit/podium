import { shallowEqual } from '@podium/client-core/store'
import { DEFAULT_SETTINGS, type PodiumSettings } from '@podium/runtime'
import type { JSX } from 'react'
import { useEffect, useState } from 'react'
import { useStoreSelector } from '@/app/store'
import type { Trpc } from '@/app/trpc'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import { MachinesPanel } from './MachinesPanel'
import { AccountsSection } from './sections/accounts'
import { AppearanceSection } from './sections/appearance'
import { HibernationSection } from './sections/hibernation'
import { IntegrationsSection } from './sections/integrations'
import { KeysSection } from './sections/keys'
import { NetworkSection } from './sections/network'
import { NotificationsSection, type TelegramSetupState } from './sections/notifications'
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
  | 'machines'
  | 'security'
  | 'updates'

export const SETTINGS_TABS: { key: SettingsTab; label: string }[] = [
  { key: 'appearance', label: 'Appearance' },
  { key: 'accounts', label: 'Accounts' },
  { key: 'sessions', label: 'New sessions' },
  { key: 'superagent', label: 'Superagent' },
  { key: 'workllm', label: 'Background LLM' },
  { key: 'keys', label: 'API keys' },
  { key: 'hibernation', label: 'Hibernation' },
  { key: 'notifications', label: 'Notifications' },
  { key: 'workflow', label: 'Workflow' },
  { key: 'integrations', label: 'Integrations' },
  { key: 'network', label: 'Network' },
  { key: 'machines', label: 'Machines' },
  { key: 'security', label: 'Security' },
  { key: 'updates', label: 'Updates' },
]

/** Everything a section can pull from the view: the loaded blob, the local
 *  patch, the accounts list, the Telegram flow state, and the store trpc. */
interface SectionContext {
  settings: PodiumSettings
  accounts: AccountView[]
  patch: (p: Partial<PodiumSettings>) => void
  trpc: Trpc
  telegramSetup: TelegramSetupState
  telegramSetupNow: number
  startTelegramSetup: () => void
  resetTelegramSetup: () => void
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
  hibernation: ({ settings, patch }) => <HibernationSection settings={settings} patch={patch} />,
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
  machines: () => <MachinesPanel />,
  security: ({ trpc }) => <LoginPasswordSection trpc={trpc} />,
  updates: () => <UpdatesSection />,
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
  const { trpc, setView, settingsTab, setSettingsTab } = useStoreSelector(
    (s) => ({
      trpc: s.trpc,
      setView: s.setView,
      settingsTab: s.settingsTab,
      setSettingsTab: s.setSettingsTab,
    }),
    shallowEqual,
  )
  const [settings, setSettings] = useState<PodiumSettings | null>(null)
  const [accounts, setAccounts] = useState<AccountView[]>([])
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [savedAt, setSavedAt] = useState(0)
  const [telegramSetup, setTelegramSetup] = useState<TelegramSetupState>({ status: 'idle' })
  const [telegramSetupNow, setTelegramSetupNow] = useState(() => Date.now())
  // The tab is the URL (/settings/:tab, issue #15 Phase 4): deep links (global
  // search, the Machines panel's "Change URL") land directly on their tab, tab
  // clicks push history entries (setSettingsTab), and back/forward moves
  // between visited tabs. A plain /settings shows the default tab.
  const tab: SettingsTab =
    settingsTab && SETTINGS_TABS.some((s) => s.key === settingsTab)
      ? (settingsTab as SettingsTab)
      : 'sessions'

  useEffect(() => {
    let cancelled = false
    trpc.settings.get
      .query()
      .then((s) => {
        if (!cancelled) setSettings(s)
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
      setSettings(await trpc.settings.set.mutate(settings))
      setSavedAt(Date.now())
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setSaving(false)
    }
  }

  const patch = (p: Partial<PodiumSettings>) => setSettings((s) => (s ? { ...s, ...p } : s))

  return (
    <section className="flex min-w-0 flex-1 flex-col overflow-hidden" aria-label="Settings">
      <div className="flex items-center justify-between border-border border-b px-4 py-3 md:px-[22px] md:py-3.5">
        <h2 className="font-medium text-base text-foreground">Settings</h2>
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          title="Close settings"
          onClick={() => setView('home')}
        >
          ✕
        </Button>
      </div>
      {error && (
        <div className="border-border border-b px-4 py-2 text-destructive text-xs">{error}</div>
      )}
      {!settings ? (
        <div className="flex-1 overflow-y-auto px-4 py-1 pb-3 md:px-[22px] md:pb-4">
          <div className="p-3 text-muted-foreground/70 text-xs">Loading settings…</div>
        </div>
      ) : (
        <div className="flex min-h-0 flex-1 flex-col md:flex-row">
          <nav
            className="flex flex-row gap-1 overflow-x-auto border-border border-b p-2 md:w-[200px] md:flex-none md:flex-col md:gap-0.5 md:overflow-y-auto md:border-r md:border-b-0 md:p-3 md:px-2 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
            aria-label="Settings sections"
          >
            {SETTINGS_TABS.map((t) => (
              <button
                key={t.key}
                type="button"
                className={cn(
                  'cursor-pointer whitespace-nowrap rounded-md px-2.5 py-2 text-left text-muted-foreground text-[13px] transition-colors hover:bg-accent hover:text-foreground',
                  t.key === tab && 'bg-accent text-foreground',
                )}
                aria-current={t.key === tab}
                onClick={() => setSettingsTab(t.key)}
              >
                {t.label}
              </button>
            ))}
          </nav>
          <div className="flex-1 overflow-y-auto px-4 py-1 pb-4 md:px-[22px]">
            {SECTION_VIEWS[tab]({
              settings,
              accounts,
              patch,
              trpc,
              telegramSetup,
              telegramSetupNow,
              startTelegramSetup: () => void startTelegramSetup(),
              resetTelegramSetup: () => setTelegramSetup({ status: 'idle' }),
            })}
          </div>
        </div>
      )}
      <div className="flex items-center justify-end gap-2.5 border-border border-t px-4 py-2.5">
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="mr-auto text-muted-foreground/70 hover:text-foreground"
          onClick={() => setSettings(DEFAULT_SETTINGS)}
        >
          Reset to defaults
        </Button>
        {savedAt > 0 && Date.now() - savedAt < 4000 && (
          <span className="text-success text-xs">Saved.</span>
        )}
        <Button type="button" size="sm" disabled={!settings || saving} onClick={() => void save()}>
          {saving ? 'Saving…' : 'Save'}
        </Button>
      </div>
    </section>
  )
}
