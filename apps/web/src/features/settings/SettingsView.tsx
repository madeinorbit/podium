import {
  canonicalSettingsPage,
  isSettingsPage,
  type SettingsPage,
} from '@podium/client-core/ui-state'
import { instancePreferences } from '@podium/client-graph/instance-preferences'
import { here } from '@podium/client-graph/lookup'
import { myPreferences } from '@podium/client-graph/per-user-records'
import {
  INSTANCE_PREFERENCES_ROW_ID,
  SETTINGS_PATH_TIERS,
  type ServerSecretKey,
} from '@podium/model/browser'
import { DEFAULT_SETTINGS, type PodiumSettings } from '@podium/runtime'
import { observer } from 'mobx-react-lite'
import type { JSX } from 'react'
import { lazy, Suspense, useCallback, useEffect, useMemo, useState } from 'react'
import { toast } from 'sonner'
import { usePoolIdleCapUnmetCount } from '@/app/header-data'
import { useWorklistPool } from '@/app/store-worklist-pool'
import type { Trpc } from '@/app/trpc'
import { WaitingForServer } from '@/components/WaitingForServer'
import { throughRestarts } from '@/lib/chunk-recovery'
import { useDeadlineNow } from '@/lib/clock-hooks'
import { AdminViewerContext, useAdminSections } from './admin-viewer'
import { SETTINGS_GROUPS } from './page-definitions'
import { useSettingsTab } from './readers'
import { accountKey, useSettingsRecords } from './record-readers'
import { SettingsOpening } from './SettingsOpening'
import { settingsChange } from './save-settings'
import { AgentsSection } from './sections/agents'
import { AppearanceSection } from './sections/appearance'
import { HibernationSection } from './sections/hibernation'
import { LabsSection } from './sections/labs'
import { MembersSection } from './sections/members'
import {
  NotificationsSection,
  type TelegramBotPresence,
  TelegramSetupContext,
  type TelegramSetupState,
} from './sections/notifications'
import { PrivacySection } from './sections/privacy'
import { type SecretSurfaceState, SecretsSection } from './sections/secrets'
import {
  type AccountView,
  SettingsControlsContext,
  type SettingsControlsState,
} from './sections/shared'
import { WorkflowSection } from './sections/workflow'
import { SettingsPageSection } from './settings-anchors'
import { SettingsFrame } from './settings-frame'
import { useSettingsClient } from './stable-access'
import { adminSectionOf, visibleSettingsGroups } from './surfaces'

export { SETTINGS_GROUPS, SETTINGS_TABS } from './page-definitions'
export type SettingsTab = SettingsPage

// Account connection and login controls are only needed on the Accounts tab.
const AccountsSection = lazy(() =>
  throughRestarts(() => import('./sections/accounts')).then((module) => ({
    default: module.AccountsSection,
  })),
)
// The repository table, its prefix editor and the grouping model behind it are
// only needed on the Repos tab, and keep the Settings chunk inside its budget.
const ReposSection = lazy(() =>
  throughRestarts(() => import('./sections/repos')).then((module) => ({
    default: module.ReposSection,
  })),
)
const MachinesPanel = lazy(() =>
  throughRestarts(() => import('./MachinesPanel')).then((module) => ({
    default: module.MachinesPanel,
  })),
)
// The admin area's Access and Audit sections are read only by admins (POD-6299).
const AccountSection = lazy(() =>
  throughRestarts(() => import('./sections/account')).then((module) => ({
    default: module.AccountSection,
  })),
)
const AccessSection = lazy(() =>
  throughRestarts(() => import('./sections/access')).then((module) => ({
    default: module.AccessSection,
  })),
)
const AuditSection = lazy(() =>
  throughRestarts(() => import('./sections/audit')).then((module) => ({
    default: module.AuditSection,
  })),
)
/**
 * The section a person opens to WATCH an update, whose chunk is therefore the
 * one most likely to be asked for while the server that serves it is restarting
 * (POD-2762). If any single import in the app had to survive that, it is this
 * one — a page that cannot show the update because of the update is the joke
 * this issue exists to stop telling.
 */
const UpdatesSection = lazy(() =>
  throughRestarts(() => import('./sections/updates')).then((module) => ({
    default: module.UpdatesSection,
  })),
)

/** The live settings, per-control writer, accounts and short-flow state. */
interface SectionContext {
  settings: PodiumSettings
  accounts: AccountView[]
  patch: (p: Partial<PodiumSettings>) => void
  trpc: Trpc
  telegramSetup: TelegramSetupState
  startTelegramSetup: () => void
  disconnectTelegram: () => Promise<void>
  telegramBotPresent: TelegramBotPresence
  refreshTelegramBot: () => void
  openNetworkSettings: () => void
  /** The secret surface: presence + fingerprint, or the single unavailable
   *  state. Never a value — the read has no value key by construction. */
  secrets: SecretSurfaceState
  /** Whether the secret WRITES may be attempted, from `settings.viewer`. */
  canManageSecrets: boolean
  secretBusy: boolean
  secretError: string | null
  setSecret: (key: ServerSecretKey, value: string) => Promise<void>
  clearSecret: (key: ServerSecretKey) => Promise<void>
}

/** The tab -> section lookup (P5d, issue #264 — replaces the JSX ladder). Most
 *  sections edit the shared blob via `patch`; instant-save sections pull what
 *  they need from the store hook. Network owns a separate staged config draft. */
const SECTION_VIEWS: Record<SettingsPage, (ctx: SectionContext) => JSX.Element> = {
  agents: ({ settings, accounts, patch }) => (
    <AgentsSection settings={settings} accounts={accounts} patch={patch} />
  ),
  appearance: ({ settings, patch }) => (
    <SettingsPageSection id="appearance">
      <AppearanceSection settings={settings} patch={patch} />
    </SettingsPageSection>
  ),
  accounts: (ctx) => (
    <>
      <SettingsPageSection id="accounts">
        <AccountsSection />
      </SettingsPageSection>
      <SettingsPageSection id="secrets">
        <SecretsSection
          state={ctx.secrets}
          canManage={ctx.canManageSecrets}
          onSet={(key, value) => void ctx.setSecret(key, value).catch(() => {})}
          onClear={(key) => void ctx.clearSecret(key).catch(() => {})}
          busy={ctx.secretBusy}
          error={ctx.secretError}
        />
      </SettingsPageSection>
    </>
  ),
  notifications: (ctx) => (
    <SettingsPageSection id="notifications">
      <NotificationsSection
        settings={ctx.settings}
        patch={ctx.patch}
        telegramSetup={ctx.telegramSetup}
        onStartTelegramSetup={ctx.startTelegramSetup}
        onDisconnectTelegram={ctx.disconnectTelegram}
        telegramBotPresent={ctx.telegramBotPresent}
        onRefreshTelegramBot={ctx.refreshTelegramBot}
        secrets={ctx.secrets}
        canManageSecrets={ctx.canManageSecrets}
        secretBusy={ctx.secretBusy}
        secretError={ctx.secretError}
        onSetSecret={ctx.setSecret}
        onClearSecret={ctx.clearSecret}
      />
    </SettingsPageSection>
  ),
  account: ({ trpc, openNetworkSettings }) => (
    <AccountSection trpc={trpc} onOpenAccess={openNetworkSettings} />
  ),
  machines: ({ settings, patch }) => (
    <>
      <SettingsPageSection id="machines">
        <MachinesPanel />
      </SettingsPageSection>
      <SettingsPageSection id="hibernation">
        <HibernationSettingsSection settings={settings} patch={patch} />
      </SettingsPageSection>
    </>
  ),
  projects: ({ settings, patch }) => (
    <>
      <SettingsPageSection id="repos">
        <ReposSection podiumDefault={settings.gitWorkflow?.defaultParentBranch ?? ''} />
      </SettingsPageSection>
      <SettingsPageSection id="workflow">
        <WorkflowSection settings={settings} patch={patch} />
      </SettingsPageSection>
    </>
  ),
  members: () => (
    <SettingsPageSection id="members">
      <MembersSection />
    </SettingsPageSection>
  ),
  access: () => <AccessSection />,
  audit: () => (
    <SettingsPageSection id="audit">
      <AuditSection />
    </SettingsPageSection>
  ),
  privacy: ({ settings, patch }) => (
    <SettingsPageSection id="privacy">
      <PrivacySection settings={settings} patch={patch} />
    </SettingsPageSection>
  ),
  updates: () => (
    <SettingsPageSection id="updates">
      <UpdatesSection />
    </SettingsPageSection>
  ),
  labs: ({ settings, patch }) => (
    <SettingsPageSection id="labs">
      <LabsSection settings={settings} patch={patch} />
    </SettingsPageSection>
  ),
}

/** This scalar demand belongs to the mounted tab, so other settings surfaces
 * never subscribe to fleet metric payloads or the hibernation aggregate. */
function HibernationSettingsSection({
  settings,
  patch,
}: Pick<SectionContext, 'settings' | 'patch'>) {
  const idleCapUnmet = usePoolIdleCapUnmetCount()
  return <HibernationSection settings={settings} patch={patch} idleCapUnmet={idleCapUnmet} />
}

/**
 * Settings — a full main-content surface (not a modal), split into sections via a
 * side nav. Each control writes its changed leaves through the settings
 * command plan and the synced record writers.
 * Each tab's section lives in ./sections/<tab>
 * and renders through the SECTION_VIEWS lookup. The Telegram connect flow's
 * state (and its poll) stays here so it survives switching tabs.
 */
export function SettingsView(props: { onClose: () => void }): JSX.Element {
  const settingsTab = useSettingsTab()
  const adminViewer = useAdminSections()
  return (
    <SettingsOpening>
      <AdminViewerContext.Provider value={adminViewer}>
        <SettingsViewBody {...props} settingsTab={settingsTab} />
      </AdminViewerContext.Provider>
    </SettingsOpening>
  )
}

const SettingsViewBody = observer(function SettingsViewBody({
  onClose,
  settingsTab,
}: {
  onClose: () => void
  settingsTab: ReturnType<typeof useSettingsTab>
}): JSX.Element {
  const { trpc, setSettingsTab, setPreferences, setInstancePreferences } = useSettingsClient()
  // The admin area is drawn only from the server's answer (POD-6299).
  const adminViewer = useAdminSections()
  const adminSections = adminViewer.sections
  const offeredGroups = visibleSettingsGroups(SETTINGS_GROUPS, adminSections)
  const settingsTabs = offeredGroups.flatMap((g) => g.tabs)
  const pool = useWorklistPool()
  // Both preference tiers are synced records: my `userPreferences` (POD-6673)
  // and the instance's `instancePreferences` (POD-6677). The screen reads each
  // group from its home, live; an admin's change on another device moves it.
  const instanceReady = pool ? instancePreferences(pool) !== undefined : false
  const myPreferencesId = pool ? myPreferences(pool)?.id : undefined
  const record = useMemo(
    () =>
      instanceReady && pool && myPreferencesId !== undefined
        ? composedSettings(
            () => here(pool.row('instancePreferences', INSTANCE_PREFERENCES_ROW_ID)),
            () => here(pool.row('userPreferences', myPreferencesId)),
          )
        : undefined,
    [instanceReady, pool, myPreferencesId],
  )
  const settings = record ?? null
  const [feedback, setFeedback] = useState<SettingsControlsState['feedback']>({})
  const readAccounts = useCallback(() => trpc.accounts.list.query(), [trpc])
  const { request: accountRequest } = useSettingsRecords('account', readAccounts, accountKey)
  const accounts = accountRequest?.models ?? []
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
  const [telegramBotPresent, setTelegramBotPresent] = useState<TelegramBotPresence>('loading')
  // The tab is the URL (/settings/:tab, issue #15 Phase 4): deep links (global
  // search, the Machines panel's "Change URL") land directly on their tab, tab
  // clicks push history entries (setSettingsTab), and back/forward moves
  // between visited tabs. A plain /settings shows the default tab.
  const canonicalTab = settingsTab ? canonicalSettingsPage(settingsTab) : null
  const requestedTab = canonicalTab && isSettingsPage(canonicalTab) ? canonicalTab : undefined
  const tabOffered = settingsTabs.some((s) => s.key === requestedTab)
  const awaitingAdmin =
    requestedTab !== undefined &&
    adminViewer.status !== 'ready' &&
    adminSectionOf(requestedTab) !== undefined &&
    !tabOffered
  const tab: SettingsTab = requestedTab && (awaitingAdmin || tabOffered) ? requestedTab : 'agents'

  /** Load presence rows, collapsing every failure into one state. A refusal,
   * missing surface and dropped connection keep the same visible answer. */
  const loadSecretPresence = useCallback((): void => {
    trpc.settings.secretPresence
      .query({})
      .then((rows) => setSecrets({ status: 'available', rows }))
      .catch(() => setSecrets({ status: 'unavailable' }))
  }, [trpc])

  const loadTelegramBotPresence = useCallback((): void => {
    trpc.settings.telegramBotPresence
      .query({})
      .then(setTelegramBotPresent)
      .catch(() => setTelegramBotPresent('unavailable'))
  }, [trpc])

  useEffect(() => {
    loadTelegramBotPresence()
    const refresh = () => {
      if (document.visibilityState === 'visible') loadTelegramBotPresence()
    }
    window.addEventListener('focus', refresh)
    document.addEventListener('visibilitychange', refresh)
    return () => {
      window.removeEventListener('focus', refresh)
      document.removeEventListener('visibilitychange', refresh)
    }
  }, [loadTelegramBotPresence])

  useEffect(() => {
    let cancelled = false
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
  }, [trpc, loadSecretPresence])

  const activeTelegramSetup = telegramSetup.status === 'polling' ? telegramSetup : null
  const activeTelegramSetupId = activeTelegramSetup?.setupId
  const activeTelegramSetupExpiresAt = activeTelegramSetup?.expiresAt
  const telegramDeadline = activeTelegramSetupExpiresAt
    ? Date.parse(activeTelegramSetupExpiresAt)
    : undefined
  const telegramDeadlineNow = useDeadlineNow(telegramDeadline)

  useEffect(() => {
    if (telegramDeadline !== undefined && telegramDeadlineNow >= telegramDeadline) {
      setTelegramSetup({ status: 'expired' })
    }
  }, [telegramDeadline, telegramDeadlineNow])

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
          // The chat binding is my `userPreferences` record, published by the
          // server's own write: it reaches the record on its own.
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
   * A SECRET WRITE IS ITS OWN COMMAND, separate from preference records.
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
      loadTelegramBotPresence()
    } catch (e) {
      // The server has already redacted this message against the contract's own
      // declaration (`redactErrorMessage`), so a handler that built its text
      // from the material cannot reach this line with it.
      setSecretError(e instanceof Error ? e.message : String(e))
      throw e
    } finally {
      setSecretBusy(false)
    }
  }

  const startTelegramSetup = async () => {
    if (!settings) return
    if (telegramBotPresent !== true) {
      setTelegramSetup({
        status: 'failed',
        message: 'An admin must set up the Telegram bot in Notifications first.',
      })
      return
    }

    setTelegramSetup({ status: 'starting' })
    try {
      // NO BLOB SAVE FIRST. The token is already persisted — it is a
      // server-owned secret written by `settings.setSecret` from Notifications’ bot
      // surface, never by this screen's Save. The previous version saved the
      // whole blob here because the token was one of its members; routing a
      // ceremony through a preference save is now neither necessary nor honest.
      const setup = await trpc.settings.telegramSetupStart.mutate()
      setTelegramSetup({ status: 'polling', ...setup })
    } catch (e) {
      setTelegramSetup({ status: 'failed', message: e instanceof Error ? e.message : String(e) })
    }
  }

  const patch = async (p: Partial<PodiumSettings>): Promise<void> => {
    if (!record) return
    const change = settingsChange(record, p)
    if (!change.paths.length) return
    const updateFeedback = (error?: string) =>
      setFeedback((current) => ({
        ...current,
        ...Object.fromEntries(
          change.paths.map((path) => [path, error ? { error } : { pending: true }]),
        ),
      }))
    const clearFeedback = () =>
      setFeedback((current) => ({
        ...current,
        ...Object.fromEntries(change.paths.map((path) => [path, {}])),
      }))
    updateFeedback()
    try {
      const undo = await change.save(
        trpc,
        () => record,
        {
          personal: setPreferences,
          instance: setInstancePreferences,
        },
        permitted,
      )
      clearFeedback()
      toast('Saved', {
        action: {
          label: 'Undo',
          onClick: () => {
            updateFeedback()
            void undo()
              .then(clearFeedback)
              .catch((error: unknown) => {
                const reason = error instanceof Error ? error.message : String(error)
                updateFeedback(reason)
                toast.error(reason)
              })
          },
        },
      })
    } catch (error) {
      updateFeedback(error instanceof Error ? error.message : String(error))
    }
  }

  return (
    <TelegramSetupContext.Provider value={telegramSetup}>
      <SettingsFrame
        page={tab}
        selectedPage={settingsTab !== null}
        onPageChange={setSettingsTab}
        onClose={onClose}
        viewer={adminViewer}
      >
        {awaitingAdmin ? (
          <p role="status" className="settings-prose text-muted-foreground">
            {adminViewer.status === 'loading'
              ? 'Checking administrator access…'
              : 'Administrator access is unavailable.'}
          </p>
        ) : settings ? (
          // The tab body is a whole surface, and a lazy section that
          // cannot be fetched leaves it blank — which is what the
          // operator is staring at during a handover (POD-2762). It says
          // so, and only when it is true.
          <SettingsControlsContext.Provider value={{ settings, permitted, feedback }}>
            <Suspense fallback={<WaitingForServer className="flex min-h-24" />}>
              {(tab === 'projects' || tab === 'machines') &&
                permitted['records.instancePreferences.edit'] !== true && (
                  <p className="settings-prose mb-4">
                    Only admins can change these. You can see what is set.
                  </p>
                )}
              {SECTION_VIEWS[tab]({
                settings,
                accounts,
                patch,
                trpc,
                telegramSetup,
                startTelegramSetup: () => void startTelegramSetup(),
                disconnectTelegram: async () => {
                  await trpc.settings.telegramDisconnect.mutate({})
                  setTelegramSetup({ status: 'idle' })
                },
                telegramBotPresent,
                refreshTelegramBot: loadTelegramBotPresence,
                openNetworkSettings: () => setSettingsTab('access'),
                secrets,
                canManageSecrets: permitted['settings.setSecret'] === true,
                secretBusy,
                secretError,
                setSecret: (key, value) =>
                  writeSecret(() => trpc.settings.setSecret.mutate({ key, value })),
                clearSecret: (key) => writeSecret(() => trpc.settings.clearSecret.mutate({ key })),
              })}
            </Suspense>
          </SettingsControlsContext.Provider>
        ) : (
          // The skeleton is the row grammar at rest: same 14px padding,
          // same control column, so nothing shifts when the blob lands.
          <div className="animate-pulse" aria-hidden="true">
            {[0, 1, 2, 3, 4].map((i) => (
              <div
                key={i}
                className="flex items-center justify-between gap-9 border-hairline-soft/50 border-b py-4 last:border-b-0"
              >
                <div className="min-w-0 space-y-2">
                  <div className="h-3.5 w-40 rounded bg-chip" />
                  {i % 2 === 0 && <div className="h-2.5 w-64 max-w-full rounded bg-chip/60" />}
                </div>
                <div className="h-8 w-[var(--settings-control-w)] flex-none rounded-md bg-chip/80" />
              </div>
            ))}
          </div>
        )}
      </SettingsFrame>
    </TelegramSetupContext.Provider>
  )
})

/** The personal groups: my `userPreferences` record (POD-6673). */
const PERSONAL_GROUPS = new Set(['roles', 'sidebar', 'autoContinue', 'notifications'])

/** The instance groups: the `instancePreferences` record (POD-6677). */
const INSTANCE_GROUPS = new Set(
  SETTINGS_PATH_TIERS.filter((field) => field.tier === 'instance-preference').map(
    (field) => field.path.split('.')[0]!,
  ),
)

/** The settings the screen edits: every group read live from its home, the
 *  personal ones from my synced record and the instance ones from the
 *  instance's. A secret-only group (`apiKeys`, `integrations`) is never on
 *  either record: it reads as the blank default, and the secret surface shows
 *  only whether a secret is set. */
function composedSettings(
  instance: () => Readonly<Record<string, unknown>> | undefined,
  mine: () => Readonly<Record<string, unknown>> | undefined,
): PodiumSettings {
  const out: Record<string, unknown> = {}
  const blank = DEFAULT_SETTINGS as unknown as Record<string, unknown>
  for (const key of new Set(SETTINGS_PATH_TIERS.map((field) => field.path.split('.')[0]!))) {
    Object.defineProperty(out, key, {
      enumerable: true,
      get: () =>
        PERSONAL_GROUPS.has(key)
          ? mine()?.[key]
          : INSTANCE_GROUPS.has(key)
            ? instance()?.[key]
            : blank[key],
    })
  }
  return out as PodiumSettings
}
