import { shallowEqual } from '@podium/client-core/store'
import type { SettingsWriteRefusal } from '@podium/commands'
import type { HostMetricsWire, ServerSecretKey } from '@podium/model'
import { DEFAULT_SETTINGS, type PodiumSettings } from '@podium/runtime'
import type { JSX } from 'react'
import { useEffect, useRef, useState } from 'react'
import { AppSheet } from '@/app/AppSheet'
import { useStoreSelector } from '@/app/store'
import type { Trpc } from '@/app/trpc'
import { Button } from '@/components/ui/button'
import { invalidateFeatures, useFeature } from '@/lib/use-feature'
import { cn } from '@/lib/utils'
import { MachinesPanel } from './MachinesPanel'
import { refusalMessage, saveSettingsAsCommands } from './save-settings'
import { AccountsSection } from './sections/accounts'
import { AppearanceSection } from './sections/appearance'
import { ExperimentalSection } from './sections/experimental'
import { HibernationSection } from './sections/hibernation'
import { NetworkSection } from './sections/network'
import { NotificationsSection, type TelegramSetupState } from './sections/notifications'
import { PrivacySection } from './sections/privacy'
import { ReposSection } from './sections/repos'
import { type SecretSurfaceState, SecretsSection } from './sections/secrets'
import { LoginPasswordSection } from './sections/security'
import { SessionsSection } from './sections/sessions'
import type { AccountView } from './sections/shared'
import { SuperagentSection } from './sections/superagent'
import { UpdatesSection } from './sections/updates'
import { WorkflowSection } from './sections/workflow'
import { WorkLlmSection } from './sections/workllm'
import {
  SETTINGS_SURFACES,
  type SettingsSurface,
  SURFACE_COPY,
  TAB_SURFACE,
  tabsOnSurface,
} from './surfaces'

export type SettingsTab =
  | 'appearance'
  | 'accounts'
  | 'sessions'
  | 'superagent'
  | 'workllm'
  | 'hibernation'
  | 'notifications'
  | 'workflow'
  | 'network'
  | 'repos'
  | 'machines'
  | 'security'
  | 'privacy'
  | 'updates'
  | 'experimental'
  | 'secrets'

/** The human name of each tab. Separate from `TAB_SURFACE` so the class table
 *  stays a classification and does not become a place copy is edited. */
const TAB_LABEL: Record<SettingsTab, string> = {
  sessions: 'New sessions',
  superagent: 'Superagent',
  workllm: 'Background LLM',
  notifications: 'Notifications',
  appearance: 'Appearance',
  accounts: 'Accounts',
  privacy: 'Privacy',
  hibernation: 'Hibernation',
  workflow: 'Workflow',
  experimental: 'Experimental',
  repos: 'Repos',
  machines: 'Machines',
  network: 'Network',
  security: 'Security',
  updates: 'Updates',
  secrets: 'Secrets',
}

/*
 * TAB_LABEL IS DECLARED BEFORE SETTINGS_GROUPS, AND THE ORDER IS LOAD-BEARING.
 *
 * `SETTINGS_GROUPS` is initialised at MODULE SCOPE and reads `TAB_LABEL` inside
 * its map. With the declaration below it, `TAB_LABEL` is in its temporal dead
 * zone when that map runs: the bundled app threw
 * `Cannot read properties of undefined (reading 'sessions')` on boot and the
 * entire shell failed to render — not the settings screen, the whole app.
 *
 * Nothing except a running browser could see it. The typecheck is happy (the
 * binding exists), and every unit test imports `surfaces.ts` directly rather
 * than through this module, so all 75 web tests stayed green against an app
 * that could not start. This is the case the brief has in mind when it requires
 * real clicks against a running app rather than unit assertions.
 */
/**
 * THE NAV, GROUPED BY VISIBILITY CLASS (POD-421) — replacing POD-127's
 * topic-based grouping.
 *
 * POD-127 grouped seventeen tabs by subject (Agents / Connections / Workspace /
 * Instance), which was the right IA for one operator. Under multi-user the
 * question a user has when they open this screen is no longer "what is this
 * about" but "who does changing this affect, and may I" — and
 * `docs/multi-user-readiness.md` §3.1.1 answers that with three classes that
 * genuinely differ. The brief's requirement is that the distinction be legible
 * to the USER rather than only enforced in the backend, so it is the grouping.
 *
 * Membership is read off `surfaces.ts`'s `TAB_SURFACE`, which is
 * `satisfies Record<SettingsTab, SettingsSurface>` — a new tab is a compile
 * error rather than a tab with no declared class.
 *
 * Routes (/settings/:tab) are unchanged for the tabs that survive. `keys` and
 * `integrations` are GONE: their entire content was password inputs bound to
 * blob members, and both are absorbed into `secrets`, which shows presence and
 * fingerprint. That is a removal, and it ratchets `audit:client-secrets`'
 * NAMED_SITE census DOWN, which is how POD-419 recorded it should land.
 */
export const SETTINGS_GROUPS: {
  label: string
  surface: SettingsSurface
  hint: string
  caveat?: string
  tabs: { key: SettingsTab; label: string }[]
}[] = SETTINGS_SURFACES.map((surface) => ({
  label: SURFACE_COPY[surface].label,
  surface,
  hint: SURFACE_COPY[surface].hint,
  ...(SURFACE_COPY[surface].caveat ? { caveat: SURFACE_COPY[surface].caveat } : {}),
  tabs: tabsOnSurface(surface).map((key) => ({ key, label: TAB_LABEL[key] })),
}))

export const SETTINGS_TABS: { key: SettingsTab; label: string }[] = SETTINGS_GROUPS.flatMap(
  (g) => g.tabs,
)

/** Tabs that edit the shared blob and ride the dirty-bar Save; the rest
 *  self-persist and apply instantly, so the bar never shows there. */
const BLOB_TABS: ReadonlySet<SettingsTab> = new Set([
  'sessions',
  'superagent',
  'workllm',
  'hibernation',
  'notifications',
  'workflow',
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
  /** The secret surface: presence + fingerprint, or the single unavailable
   *  state. Never a value — the read has no value key by construction. */
  secrets: SecretSurfaceState
  /** Whether the secret WRITES may be attempted, from `settings.viewer`. */
  canManageSecrets: boolean
  secretBusy: boolean
  secretError: string | null
  setSecret: (key: ServerSecretKey, value: string) => void
  clearSecret: (key: ServerSecretKey) => void
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
  secrets: (ctx) => (
    <SecretsSection
      state={ctx.secrets}
      canManage={ctx.canManageSecrets}
      onSet={ctx.setSecret}
      onClear={ctx.clearSecret}
      busy={ctx.secretBusy}
      error={ctx.secretError}
    />
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
export function SettingsView({ onClose }: { onClose: () => void }): JSX.Element {
  const { trpc, settingsTab, setSettingsTab, hostMetrics } = useStoreSelector(
    (s) => ({
      trpc: s.trpc,
      settingsTab: s.settingsTab,
      setSettingsTab: s.setSettingsTab,
      hostMetrics: s.hostMetrics,
    }),
    shallowEqual,
  )
  const notificationsEnabled = useFeature('notifications')
  // The nav filter is experimental (off by default) — Settings → Experimental.
  const searchEnabled = useFeature('settings-search')
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
  /** What the last save could NOT write, and why — POD-420's surfaced refusal.
   *  Distinct from `error`: a refusal is an outcome the save DECIDED, not a
   *  request that failed, and the two read differently to a user. */
  const [refusals, setRefusals] = useState<readonly SettingsWriteRefusal[]>([])
  const [savedAt, setSavedAt] = useState(0)
  const [filter, setFilter] = useState('')
  /**
   * THE SECRET SURFACE, AND WHY IT HAS ONLY THREE STATES (POD-421).
   *
   * `loading`, `available`, `unavailable`. There is deliberately no `error`
   * state and no reason attached to `unavailable`: readiness §3.1.5 requires an
   * unauthorized read to fail IDENTICALLY to a nonexistent one, *"and that is as
   * true of an error toast as of an API status code."* A `{ reason: 'forbidden'
   * | 'empty' }` discriminant would rebuild the oracle inside the client, one
   * helpful-error-message commit away from rendering the distinction.
   *
   * So every failure of this read — a refusal, an instance with no surface, a
   * transport error — lands in the same state, through the same effect, at the
   * same point in the render. The server does its half (`SECRET_SURFACE_ABSENT`
   * is one exported constant used by both paths); this is the client's.
   */
  const [secrets, setSecrets] = useState<SecretSurfaceState>({ status: 'loading' })
  const [secretBusy, setSecretBusy] = useState(false)
  const [secretError, setSecretError] = useState<string | null>(null)
  /**
   * Which settings commands this caller may ATTEMPT, from `settings.viewer`.
   *
   * DEFAULT-CLOSED: an empty object until the read answers, so a control is
   * never enabled on an assumption. It is a RENDERING HINT with no authority —
   * the server re-runs the identical gate at apply time (ADR 3 D8) — and it is
   * never stored, never queued and never attached to a command. That is what
   * keeps POD-352's "no serialized effective-capability snapshot" item true: it
   * is recomputed per request from the live account role.
   */
  const [permitted, setPermitted] = useState<Record<string, boolean>>({})
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
    trpc.settings.viewer
      .query()
      .then((v) => {
        if (!cancelled) setPermitted(v.permitted)
      })
      // Stays default-closed on failure. A `catch` that enabled the controls
      // "because we could not check" is the fails-open spelling of this.
      .catch(() => {})
    loadSecretPresence()
    return () => {
      cancelled = true
    }
    // biome-ignore lint/correctness/useExhaustiveDependencies: `loadSecretPresence`
    // is defined below and closes over `trpc` only; listing it would reorder the
    // declaration without changing what the effect depends on.
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

  /**
   * Load the presence rows, collapsing EVERY failure into one state.
   *
   * The `catch` is deliberately reason-blind. A refusal, an instance with no
   * secret surface and a dropped connection are three different facts and the
   * user is told the same thing about all three, because telling them apart is
   * precisely the existence leak the admin floor exists to prevent.
   */
  const loadSecretPresence = (): void => {
    trpc.settings.secretPresence
      .query({})
      .then((rows) => setSecrets({ status: 'available', rows }))
      .catch(() => setSecrets({ status: 'unavailable' }))
  }

  /**
   * A SECRET WRITE IS ITS OWN COMMAND, issued here and NOT through the save bar.
   *
   * The blob save (`saveSettingsAsCommands`) plans preference patches from a
   * before/after diff of `PodiumSettings`. A secret is no longer IN that object
   * on this screen — there is no value to diff — so routing these through it
   * would mean putting the material back into the blob to take it out again.
   * They go straight to the contracted, online-only, admin-grade commands.
   *
   * The response is a presence projection, so the reload below costs nothing in
   * exposure: it re-reads presence and fingerprint, which is all there is.
   */
  const writeSecret = async (run: () => Promise<unknown>): Promise<void> => {
    setSecretBusy(true)
    setSecretError(null)
    try {
      await run()
      loadSecretPresence()
    } catch (e) {
      // The server has already redacted this message against the contract's own
      // declaration (`redactErrorMessage`), so a handler that built its text
      // from the material cannot reach this line with it.
      setSecretError(e instanceof Error ? e.message : String(e))
    } finally {
      setSecretBusy(false)
    }
  }

  /**
   * THE PRECONDITION IS NOW READ FROM PRESENCE, NOT FROM THE BLOB (POD-421).
   *
   * This guard used to read `settings.notifications.telegramBotToken` and refuse
   * with "Paste a Telegram bot token first" when it was blank. POD-419 removed
   * the material from the blob, so that member is now ALWAYS `''` — the guard
   * would have refused every ceremony on every instance, including ones with a
   * token perfectly well configured, and the message would have told the user to
   * do something the screen no longer lets them do.
   *
   * Worth naming as a defect class rather than fixing quietly: a UI predicate
   * over a field whose value was relocated does not fail loudly, it inverts. It
   * kept typechecking, it kept rendering, and it started answering "no" to a
   * question it used to answer correctly.
   *
   * Presence is the fact this actually needs, and it is exactly what the surface
   * publishes. `undefined` — the surface is unavailable to this caller — is
   * treated as NOT satisfied, which is the fail-closed arm: a member cannot
   * start the ceremony, and the server's own `startTelegramSetup` refuses
   * without a token anyway.
   */
  const botTokenPresent =
    secrets.status === 'available' &&
    secrets.rows.some((r) => r.key === 'notifications.telegramBotToken' && r.present)

  const startTelegramSetup = async () => {
    if (!settings) return
    if (!botTokenPresent) {
      setTelegramSetup({
        status: 'failed',
        message: 'An admin must save a Telegram bot token under Secrets first.',
      })
      return
    }

    setError(null)
    setTelegramSetup({ status: 'starting' })
    try {
      // NO BLOB SAVE FIRST. The token is already persisted — it is a
      // server-owned secret written by `settings.setSecret` from the Secrets
      // surface, never by this screen's Save. The previous version saved the
      // whole blob here because the token was one of its members; routing a
      // ceremony through a preference save is now neither necessary nor honest.
      const setup = await trpc.settings.telegramSetupStart.mutate()
      setTelegramSetup({ status: 'polling', ...setup })
      setTelegramSetupNow(Date.now())
    } catch (e) {
      setTelegramSetup({ status: 'failed', message: e instanceof Error ? e.message : String(e) })
    }
  }

  /**
   * SAVE IS NOW A PLAN, NOT A BLOB (POD-420).
   *
   * `saveSettingsAsCommands` asks the contract table which commands this edit
   * requires — a personal-preference patch, an instance-preference patch, a
   * secret replace, a secret clear — and issues those. The decision lives in
   * `@podium/commands`; this component only renders the outcome.
   *
   * A partial save is a real outcome: offline, the preferences go through and
   * the secret is refused, `refusals` names the field, and the refused input
   * stays exactly as the user typed it rather than being reverted under them.
   */
  const save = async () => {
    if (!settings) return
    setSaving(true)
    setError(null)
    try {
      const { saved, refusals } = await saveSettingsAsCommands(
        trpc,
        lastSaved ?? settings,
        settings,
      )
      setLastSaved(saved)
      setRefusals(refusals)
      if (refusals.length === 0) setSettings(saved)
      // Refresh feature gates so useFeature sees the saved experimental toggles
      // [spec:SP-f4b9].
      invalidateFeatures(trpc)
      // No "Saved ✓" flash over a refusal: something was not saved, and the bar
      // must say so rather than showing both messages in sequence.
      if (refusals.length === 0) setSavedAt(Date.now())
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setSaving(false)
    }
  }

  const patch = (p: Partial<PodiumSettings>) => setSettings((s) => (s ? { ...s, ...p } : s))
  const dirty =
    settings !== null &&
    lastSaved !== null &&
    JSON.stringify(settings) !== JSON.stringify(lastSaved)
  // The saved flash keeps the bar visible for a beat after a successful save.
  const [, forceTick] = useState(0)
  const savedFlash = savedAt > 0 && Date.now() - savedAt < 1500
  useEffect(() => {
    if (!savedFlash) return
    const id = window.setTimeout(() => forceTick((n) => n + 1), 1600)
    return () => window.clearTimeout(id)
  }, [savedFlash])
  const refusalText = refusalMessage(refusals)
  const showBar =
    BLOB_TABS.has(tab) && (dirty || saving || savedFlash || Boolean(error) || Boolean(refusalText))
  const discard = () => {
    setSettings(lastSaved)
    setError(null)
    setRefusals([])
  }

  const filterRef = useRef<HTMLInputElement | null>(null)
  const query = searchEnabled ? filter.trim().toLowerCase() : ''
  const visibleGroups = SETTINGS_GROUPS.map((g) => ({
    ...g,
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
      if (e.key === '/' && !typing && searchEnabled) {
        e.preventDefault()
        filterRef.current?.focus()
      } else if ((e.metaKey || e.ctrlKey) && e.key === 's') {
        e.preventDefault()
        if (dirty && !saving && BLOB_TABS.has(tab)) void save()
      }
      // Escape belongs to the sheet (AppSheet), which owns closing for every
      // utility overlay — one handler, one behaviour.
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  })

  return (
    <AppSheet
      label="Settings"
      title="Settings"
      testId="settings-sheet"
      onClose={onClose}
      toolbar={
        error && !settings ? <span className="text-destructive text-xs">{error}</span> : undefined
      }
    >
      {/* TWO PANES, FULL BLEED (POD-365). This was a 1100px column centred in the
          viewport, which left ~45% of a 1600px window as empty chassis — a
          documentation-site measure. The rail is fixed, the pane takes the rest,
          and the 62ch cap that keeps prose readable lives INSIDE the pane. */}
      <div className="settings-panes">
        <nav
          className="settings-rail [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
          aria-label="Settings sections"
        >
          {searchEnabled && (
            <div className="relative mb-2">
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
          )}
          {visibleGroups.map((g) => (
            <div key={g.label}>
              {/* The group's sentence is NOT repeated here. The pane's banner
                    states it verbatim and both were on screen at once — the same
                    three sentences twice, once ragged into a 20ch rail. A nav
                    lists destinations; the destination explains itself. */}
              <div className="mt-5 mb-1 px-2.5 first:mt-0">
                <div className="font-medium font-mono text-[8.5px] text-label uppercase tracking-[0.12em]">
                  {g.label}
                </div>
              </div>
              {g.tabs.map((t) => (
                <button
                  data-pressable
                  key={t.key}
                  type="button"
                  className={cn(
                    'block w-full cursor-pointer whitespace-nowrap rounded-md px-2.5 py-[5px] text-left text-[12.5px] text-muted-foreground transition-colors hover:bg-accent/60 hover:text-foreground',
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
            <p className="px-2 pt-1 text-[11.5px] text-text-dim">
              No section matches “{filter.trim()}”.
            </p>
          )}
        </nav>
        <div className="settings-pane">
          <div className="settings-pane-scroll">
            <div className="settings-section-enter settings-measure" key={tab}>
              {/* THE CLASS CAPTION. What changing anything on this tab affects,
                    stated on the tab itself — a nav heading is easy to scroll
                    past, and the caveat below is the one thing on this screen a
                    user must not miss. It was a bordered chip card, which made
                    the pane's quietest content its loudest object and put a card
                    above the heading it introduces; a mono class label over the
                    sentence, closed by the rule that already separates it from
                    the first section, says the same thing without a box. */}
              {(() => {
                const surface = TAB_SURFACE[tab]
                const copy = SURFACE_COPY[surface]
                return (
                  <div
                    className="mb-5 border-hairline-soft border-b pb-4"
                    data-testid={`surface-banner-${surface}`}
                  >
                    {/* No class label here: the rail names the group two
                        centimetres to the left and on the same line, so
                        repeating it read as a rendering fault. The sentence is
                        self-contained. */}
                    <p className="max-w-[62ch] text-[11.5px] text-text-dim leading-normal">
                      {copy.hint}
                    </p>
                    {copy.caveat && (
                      <p
                        className="mt-1 max-w-[62ch] text-[11px] text-warning leading-normal"
                        data-testid="surface-caveat"
                      >
                        {copy.caveat}
                      </p>
                    )}
                  </div>
                )
              })()}
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
                  secrets,
                  canManageSecrets: permitted['settings.setSecret'] === true,
                  secretBusy,
                  secretError,
                  setSecret: (key, value) => {
                    void writeSecret(() => trpc.settings.setSecret.mutate({ key, value }))
                  },
                  clearSecret: (key) => {
                    void writeSecret(() => trpc.settings.clearSecret.mutate({ key }))
                  },
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
              'absolute right-6 bottom-4 left-6 z-10 flex max-w-[780px] items-center gap-2 rounded-lg border border-border-strong bg-chip py-1.5 pr-1.5 pl-3.5 shadow-[0_14px_34px_rgb(0_0_0_/_0.65),0_2px_8px_rgb(0_0_0_/_0.5)] transition-[transform,opacity] duration-200 ease-out motion-reduce:transition-none',
              showBar
                ? 'translate-y-0 opacity-100'
                : 'pointer-events-none translate-y-16 opacity-0',
            )}
            aria-hidden={!showBar}
          >
            <span
              className={cn(
                'min-w-0 flex-1 truncate text-[12px]',
                error || refusalText ? 'text-destructive' : 'text-foreground',
              )}
              // The refusal is the message a user acts on, so it is announced
              // rather than left to be noticed in a bar they were not reading.
              role={refusalText ? 'alert' : undefined}
              data-settings-refusal={refusalText ? 'true' : undefined}
              title={refusalText ?? undefined}
            >
              {error ? error : (refusalText ?? (dirty || saving ? 'Unsaved changes' : 'Saved ✓'))}
            </span>
            {(dirty || error) && (
              <Button type="button" variant="ghost" size="sm" onClick={discard}>
                Discard
              </Button>
            )}
            {(dirty || saving || error) && (
              <Button
                type="button"
                size="sm"
                pending={saving}
                pendingLabel="Saving…"
                onClick={() => void save()}
              >
                Save changes
              </Button>
            )}
          </div>
        </div>
      </div>
    </AppSheet>
  )
}
