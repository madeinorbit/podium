import {
  canonicalSettingsPage,
  isSettingsPage,
  type SettingsPage,
} from '@podium/client-core/ui-state'
import { instancePreferences } from '@podium/client-graph/instance-preferences'
import { here } from '@podium/client-graph/lookup'
import { myPreferences } from '@podium/client-graph/per-user-records'
import type { SettingsWriteRefusal } from '@podium/commands/settings-write-plan'
import {
  INSTANCE_PREFERENCES_ROW_ID,
  SETTINGS_PATH_TIERS,
  type ServerSecretKey,
} from '@podium/model/browser'
import { DEFAULT_SETTINGS, type PodiumSettings } from '@podium/runtime'
import { observer } from 'mobx-react-lite'
import type { JSX } from 'react'
import { lazy, Suspense, useCallback, useEffect, useMemo, useState } from 'react'
import { usePoolIdleCapUnmetCount } from '@/app/header-data'
import { useWorklistPool } from '@/app/store-worklist-pool'
import type { Trpc } from '@/app/trpc'
import { Button } from '@/components/ui/button'
import { WaitingForServer } from '@/components/WaitingForServer'
import type { NetworkSaveController } from '@/features/setup/network-step'
import { throughRestarts } from '@/lib/chunk-recovery'
import { useDeadlineNow } from '@/lib/clock-hooks'
import { cn } from '@/lib/utils'
import { AdminViewerContext, useAdminSections } from './admin-viewer'
import { SETTINGS_GROUPS } from './page-definitions'
import { useSettingsTab } from './readers'
import { accountKey, useSettingsRecords } from './record-readers'
import { SettingsOpening } from './SettingsOpening'
import { refusalMessage, saveSettingsAsCommands } from './save-settings'
import { AppearanceSection } from './sections/appearance'
import { ExperimentalSection } from './sections/experimental'
import { HibernationSection } from './sections/hibernation'
import { MembersSection } from './sections/members'
import { NetworkSection } from './sections/network'
import { NotificationsSection, type TelegramSetupState } from './sections/notifications'
import { PodiumAccountSection } from './sections/podium-account'
import { PrivacySection } from './sections/privacy'
import { type SecretSurfaceState, SecretsSection } from './sections/secrets'
import { LoginPasswordSection } from './sections/security'
import { SessionsSection } from './sections/sessions'
import type { AccountView } from './sections/shared'
import { SuperagentSection } from './sections/superagent'
import { WorkflowSection } from './sections/workflow'
import { WorkLlmSection } from './sections/workllm'
import { SettingsPageSection } from './settings-anchors'
import { SettingsEditDraft } from './settings-edit-draft'
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
const ConnectedDevicesSection = lazy(() =>
  throughRestarts(() => import('./sections/connected-devices')).then((module) => ({
    default: module.ConnectedDevicesSection,
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

/** Pages retaining the existing staged preference controls. */
const BLOB_TABS: ReadonlySet<SettingsPage> = new Set([
  'agents',
  'machines',
  'notifications',
  'projects',
  'labs',
])

/** Everything a section can pull from the view: the loaded blob, the local
 *  patch, the accounts list, the Telegram flow state, and the store trpc. */
interface SectionContext {
  settings: PodiumSettings
  accounts: AccountView[]
  patch: (p: Partial<PodiumSettings>) => void
  trpc: Trpc
  telegramSetup: TelegramSetupState
  startTelegramSetup: () => void
  resetTelegramSetup: () => void
  openNetworkSettings: () => void
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
  setNetworkSaveState: (state: NetworkSaveController | null) => void
}

/** The tab -> section lookup (P5d, issue #264 — replaces the JSX ladder). Most
 *  sections edit the shared blob via `patch`; instant-save sections pull what
 *  they need from the store hook. Network owns a separate staged config draft. */
const SECTION_VIEWS: Record<SettingsPage, (ctx: SectionContext) => JSX.Element> = {
  agents: ({ settings, accounts, patch }) => (
    <>
      <SettingsPageSection id="sessions">
        <SessionsSection settings={settings} accounts={accounts} patch={patch} />
      </SettingsPageSection>
      <SettingsPageSection id="superagent">
        <SuperagentSection settings={settings} accounts={accounts} patch={patch} />
      </SettingsPageSection>
      <SettingsPageSection id="workllm">
        <WorkLlmSection settings={settings} accounts={accounts} patch={patch} />
      </SettingsPageSection>
    </>
  ),
  appearance: () => (
    <SettingsPageSection id="appearance">
      <AppearanceSection />
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
          onSet={ctx.setSecret}
          onClear={ctx.clearSecret}
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
        onResetTelegramSetup={ctx.resetTelegramSetup}
      />
    </SettingsPageSection>
  ),
  account: ({ trpc, openNetworkSettings }) => (
    <>
      <SettingsPageSection id="podium-account">
        <PodiumAccountSection />
      </SettingsPageSection>
      <SettingsPageSection id="security">
        <LoginPasswordSection trpc={trpc} />
      </SettingsPageSection>
      <SettingsPageSection id="devices">
        <ConnectedDevicesSection trpc={trpc} onOpenNetwork={openNetworkSettings} />
      </SettingsPageSection>
    </>
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
  access: ({ setNetworkSaveState }) => (
    <>
      <SettingsPageSection id="network">
        <NetworkSection onSaveStateChange={setNetworkSaveState} />
      </SettingsPageSection>
      <SettingsPageSection id="access">
        <AccessSection />
      </SettingsPageSection>
    </>
  ),
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
  labs: ({ settings, patch, resetToDefaults }) => (
    <SettingsPageSection id="experimental">
      <ExperimentalSection settings={settings} patch={patch} onReset={resetToDefaults} />
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
 * side nav. Edits the shared settings record through touched-field drafts and
 * submits its changed leaves through the settings command plan.
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
  // and the instance's `instancePreferences` (POD-6677). The draft reads each
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
  const edits = useMemo(
    () =>
      record
        ? new SettingsEditDraft(record, async (previous, next) => {
            return await saveSettingsAsCommands(trpc, previous, next, {
              personal: setPreferences,
              instance: setInstancePreferences,
            })
          })
        : null,
    [record, trpc, setPreferences, setInstancePreferences],
  )
  const settings = edits?.settings ?? null
  const readAccounts = useCallback(() => trpc.accounts.list.query(), [trpc])
  const { request: accountRequest } = useSettingsRecords('account', readAccounts, accountKey)
  const accounts = accountRequest?.models ?? []
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  /** What the last save could NOT write, and why — POD-420's surfaced refusal.
   *  Distinct from `error`: a refusal is an outcome the save DECIDED, not a
   *  request that failed, and the two read differently to a user. */
  const [refusals, setRefusals] = useState<readonly SettingsWriteRefusal[]>([])
  const [savedAt, setSavedAt] = useState(0)
  const [networkSave, setNetworkSave] = useState<NetworkSaveController | null>(null)
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
          // server's own write: it reaches the draft on its own.
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
        message: 'An admin must save a Telegram bot token under AI accounts first.',
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
    if (!edits?.isDirty || saving) return
    setSaving(true)
    setError(null)
    try {
      const result = await edits.submit()
      if (!result) return
      const { refusals } = result
      setRefusals(refusals)
      // No "Saved ✓" flash over a refusal: something was not saved, and the bar
      // must say so rather than showing both messages in sequence.
      if (refusals.length === 0) setSavedAt(Date.now())
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setSaving(false)
    }
  }

  const patch = (p: Partial<PodiumSettings>) => edits?.patch(p)
  const dirty = edits?.isDirty ?? false
  // The saved flash keeps the bar visible for a beat after a successful save.
  const [, forceTick] = useState(0)
  const savedFlash = savedAt > 0 && Date.now() - savedAt < 1500
  useEffect(() => {
    if (!savedFlash) return
    const id = window.setTimeout(() => forceTick((n) => n + 1), 1600)
    return () => window.clearTimeout(id)
  }, [savedFlash])
  const refusalText = refusalMessage(refusals)
  const blobSaveActive = BLOB_TABS.has(tab)
  const networkSaveActive = tab === 'access' ? networkSave : null
  const activeDirty = blobSaveActive ? dirty : (networkSaveActive?.dirty ?? false)
  const activeSaving = blobSaveActive ? saving : (networkSaveActive?.saving ?? false)
  const activeError = blobSaveActive ? error : (networkSaveActive?.error ?? null)
  const activeSavedFlash = blobSaveActive
    ? savedFlash
    : Boolean(networkSaveActive?.savedAt && Date.now() - networkSaveActive.savedAt < 1500)
  useEffect(() => {
    if (!networkSaveActive?.savedAt || !activeSavedFlash) return
    const id = window.setTimeout(() => forceTick((n) => n + 1), 1600)
    return () => window.clearTimeout(id)
  }, [activeSavedFlash, networkSaveActive?.savedAt])
  const activeRefusalText = blobSaveActive ? refusalText : null
  const showBar =
    (blobSaveActive || Boolean(networkSaveActive)) &&
    (activeDirty ||
      activeSaving ||
      activeSavedFlash ||
      Boolean(activeError) ||
      Boolean(activeRefusalText))
  /**
   * CLOSING WITH UNSAVED EDITS. Escape and a backdrop click are both one
   * keystroke or one stray click away at all times, and both used to drop a
   * half-finished settings edit on the floor silently. They now REFUSE while the
   * dirty bar is up.
   *
   * A refusal rather than a confirm dialog, deliberately: a sheet may not open a
   * second modal layer over itself (DESIGN.md §The Sheet Tier), and the bar this
   * points at already carries the only two answers a confirm would offer —
   * Discard and Save changes. So the refusal sends the eye to the control that
   * resolves it rather than stacking a copy of that control on top of it.
   *
   * It must not be silent, or Escape reads as broken: the bar takes the message
   * for a beat, announces it, and nudges once.
   */
  const [closeBlockedAt, setCloseBlockedAt] = useState(0)
  const closeBlocked = closeBlockedAt > 0 && Date.now() - closeBlockedAt < 2600
  const discard = () => {
    if (networkSaveActive) networkSaveActive.discard()
    else {
      edits?.reset()
      setError(null)
      setRefusals([])
    }
    setCloseBlockedAt(0)
  }
  useEffect(() => {
    if (!closeBlocked) return
    const id = window.setTimeout(() => forceTick((n) => n + 1), 2700)
    return () => window.clearTimeout(id)
  }, [closeBlocked])
  // Gated on the same condition as the bar itself: a refusal the user has no
  // visible reason for is indistinguishable from a broken Escape key.
  const blocksClose = activeDirty || activeSaving
  const requestClose = (): void => {
    if (blocksClose) {
      setCloseBlockedAt(Date.now())
      return
    }
    onClose()
  }

  // ⌘S keeps the existing staged save behavior. The frame owns search keys.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 's') {
        e.preventDefault()
        if (activeDirty && !activeSaving) {
          if (networkSaveActive) void networkSaveActive.save()
          else if (blobSaveActive) void save()
        }
      }
      // Escape belongs to the sheet (AppSheet), which owns closing for every
      // utility overlay — one handler, one behaviour.
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  })

  return (
    <SettingsFrame
      page={tab}
      onPageChange={setSettingsTab}
      onClose={requestClose}
      viewer={adminViewer}
      toolbar={
        error && !settings ? (
          <span className="text-[12px] text-destructive">{error}</span>
        ) : undefined
      }
      footer={
        <div
          className={cn(
            // The lifted tier read from the token rather than restated: black
            // at that alpha is depth on navy and dirt on paper (POD-388).
            // Left edge on the form's own left edge, and no wider than the
            // form: a bar that spans further than the column it belongs to
            // reads as the sheet's furniture rather than as this form's.
            'absolute right-8 bottom-4 left-8 z-10 flex max-w-[var(--settings-form-w)] items-center gap-2 rounded-lg border border-border-strong bg-chip py-2 pr-2 pl-4 shadow-[var(--shadow-popover)] transition-[transform,opacity] duration-200 ease-out motion-reduce:transition-none',
            showBar ? 'translate-y-0 opacity-100' : 'pointer-events-none translate-y-16 opacity-0',
            // One nudge when a close was refused — a single one-shot morph,
            // then stillness, which is the shell's whole motion grammar. The
            // ring is what makes the bar findable if it had scrolled out of
            // the eye's attention.
            closeBlocked && 'settings-bar-nudge ring-1 ring-attention/60',
          )}
          aria-hidden={!showBar}
        >
          <span
            className={cn(
              'min-w-0 flex-1 truncate text-[13px]',
              activeError || activeRefusalText ? 'text-destructive' : 'text-foreground',
            )}
            // A refusal — of a write, or of the close that would have thrown
            // the edit away — is the message a user acts on, so it is
            // announced rather than left to be noticed in a bar they were not
            // reading.
            role={activeRefusalText || closeBlocked ? 'alert' : undefined}
            data-settings-refusal={activeRefusalText ? 'true' : undefined}
            data-settings-close-blocked={closeBlocked ? 'true' : undefined}
            title={activeRefusalText ?? undefined}
          >
            {activeError
              ? activeError
              : (activeRefusalText ??
                (closeBlocked
                  ? 'Unsaved changes — save or discard first'
                  : activeDirty || activeSaving
                    ? 'Unsaved changes'
                    : 'Saved ✓'))}
          </span>
          {(activeDirty || activeError) && (
            <Button type="button" variant="ghost" size="sm" onClick={discard}>
              Discard
            </Button>
          )}
          {(activeDirty || activeSaving || activeError) && (
            <Button
              type="button"
              size="sm"
              pending={activeSaving}
              pendingLabel="Saving…"
              onClick={() => {
                if (networkSaveActive) void networkSaveActive.save()
                else void save()
              }}
            >
              Save changes
            </Button>
          )}
        </div>
      }
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
        <Suspense fallback={<WaitingForServer className="flex min-h-24" />}>
          {SECTION_VIEWS[tab]({
            settings,
            accounts,
            patch,
            trpc,
            telegramSetup,
            startTelegramSetup: () => void startTelegramSetup(),
            resetTelegramSetup: () => setTelegramSetup({ status: 'idle' }),
            openNetworkSettings: () => setSettingsTab('access'),
            resetToDefaults: () => edits?.patch(DEFAULT_SETTINGS),
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
            setNetworkSaveState: setNetworkSave,
          })}
        </Suspense>
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
