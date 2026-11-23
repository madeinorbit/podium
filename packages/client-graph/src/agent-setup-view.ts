/**
 * THE "SET UP AGENTS" PANEL (POD-6858): one view model per opening, shared by
 * the web panel, the phone sheet, the menus' "Set up agents" entry and
 * onboarding. It answers every install, sign-in and failure question the panel
 * shows, so no screen re-derives them from inventory.
 *
 * Facts stay on the shared machine model and its {@link MachineHarness} rows;
 * this view adds only what the panel decides: grouping, selection, the
 * person's sign-in choice during this opening, the action answers it ran, and
 * the hand-back to whatever opened it.
 *
 * Podium installs only when a person asks: nothing here runs an action except
 * a method a person's press calls.
 */

import { companion, lazy } from '@podium/mobx-helpers'
import type { BuiltinHarnessKind, SessionId } from '@podium/model'
import type { HarnessActionResult, HarnessInstallAction } from '@podium/protocol'
import { action, compareShallow, observable, observableRef, runInAction } from 'mobx'
import { HarnessInstallAnswer, type HarnessInstallClient } from './harness-installs-view'
import type { MachineHarness } from './machine-harness'
import { answerError } from './request-answer'
import type { MachineModel } from './synced-models'

// ---------------------------------------------------------------------------
// Inputs
// ---------------------------------------------------------------------------

/** Who opened the panel. A menu or onboarding hands the focused harness back. */
export interface AgentSetupOrigin {
  readonly kind: 'menu' | 'settings' | 'onboarding'
  readonly onStart?: (harness: BuiltinHarnessKind) => void
}

/** `credentials.login`: a terminal session on the machine where the harness signs in. */
export interface AgentSignInClient {
  credentials: {
    login: {
      mutate(input: {
        harness: BuiltinHarnessKind
        machineId: MachineModel['id']
      }): Promise<{ sessionId: SessionId }>
    }
  }
}

/** A saved credential a harness accepts, as the credentials list names it. */
export interface SavedCredentialChoice {
  readonly id: string
  readonly label: string
  readonly hint?: string
}

/**
 * The person's own `credentialDefaults` (personal preferences): read live from
 * the synced record, written through the settings patch. A harness's default
 * applies to every session the person starts with it, on any machine.
 */
export interface AgentSetupPreferences {
  credentialDefaults(): Readonly<Partial<Record<BuiltinHarnessKind, string>>>
  saveCredentialDefaults(next: Partial<Record<BuiltinHarnessKind, string>>): void | Promise<void>
  /** Saved credentials this harness accepts; empty when there are none. */
  savedCredentials(harness: BuiltinHarnessKind): readonly SavedCredentialChoice[]
}

export interface AgentSetupOptions {
  readonly machine: MachineModel
  readonly client: HarnessInstallClient & AgentSignInClient
  readonly preferences: AgentSetupPreferences
  readonly origin: AgentSetupOrigin
  /** The harness the opener asked about; the panel hands it back once ready. */
  readonly focus?: BuiltinHarnessKind
}

// ---------------------------------------------------------------------------
// Fields the install-progress task adds to MachineHarness (POD-7471). Read
// when present; their types flow in once that task lands.
// ---------------------------------------------------------------------------

type FieldOf<T, K extends string> = T extends { readonly [P in K]: infer V } ? V : undefined
/** `MachineHarness.progress` once POD-7471 lands, else always undefined. */
export type AgentInstallProgress = FieldOf<MachineHarness, 'progress'>
type HarnessLastError = { readonly message: string; readonly at?: string }

function rowField<V>(row: MachineHarness, key: 'progress' | 'lastError'): V | undefined {
  return (row as unknown as Partial<Record<typeof key, V>>)[key]
}

/** Actions POD-7471 adds; spelled as strings until the protocol enum has them. */
const CANCEL = 'cancel-install' as HarnessInstallAction

// ---------------------------------------------------------------------------
// Groups
// ---------------------------------------------------------------------------

export type AgentSetupStatus =
  | 'failed'
  | 'installing'
  | 'ready'
  | 'needs-sign-in'
  | 'not-installed'
  | 'blocked'

/** Panel order; a group shows only when it holds a harness. */
export const AGENT_SETUP_GROUP_ORDER: readonly AgentSetupStatus[] = [
  'failed',
  'installing',
  'ready',
  'needs-sign-in',
  'not-installed',
  'blocked',
]

export const AGENT_SETUP_GROUP_TITLE: Readonly<Record<AgentSetupStatus, string>> = {
  failed: 'Didn’t install',
  installing: 'Installing',
  ready: 'Ready',
  'needs-sign-in': 'Needs sign-in',
  'not-installed': 'Not installed',
  blocked: 'Can’t install here',
}

/** Summary line order: what works first. */
const SUMMARY_ORDER: readonly AgentSetupStatus[] = [
  'ready',
  'installing',
  'needs-sign-in',
  'not-installed',
  'failed',
  'blocked',
]
const SUMMARY_WORDS: Readonly<Record<AgentSetupStatus, string>> = {
  ready: 'ready',
  installing: 'installing',
  'needs-sign-in': 'needs sign-in',
  'not-installed': 'not installed',
  failed: 'didn’t install',
  blocked: 'can’t install here',
}

export interface AgentSetupGroup {
  readonly status: AgentSetupStatus
  readonly title: string
  readonly items: readonly AgentSetupItem[]
}

/** Who installed the copy sessions run. */
export type AgentSetupSource = 'podium' | 'own' | 'both'

/** The sign-in a session would get, as the panel names it. */
export type AgentSignInState =
  /** The machine reports a login. */
  | 'signed-in'
  /** The harness has no login detector; sessions find out at start. */
  | 'unknown'
  /** The person's saved credential is this harness's default. */
  | 'saved-credential'
  /** The person chose to sign in later, in this opening. */
  | 'later'
  /** `credentials.login` is opening the sign-in terminal. */
  | 'opening'
  /** The sign-in terminal is open; the machine has not reported a login yet. */
  | 'signing-in'
  /** Signed out, nothing chosen yet. */
  | 'signed-out'

/** What a "Can't install here" or a prerequisite warning says, and how to fix it. */
export interface AgentSetupBlock {
  readonly reason: string
  readonly fix?: string
}

// ---------------------------------------------------------------------------
// One harness in the panel
// ---------------------------------------------------------------------------

/** The panel's rules for one harness row on this machine. */
export class AgentSetupItem {
  /** The answer to the last action this opening ran for the harness. */
  readonly answer = new HarnessInstallAnswer()
  /** The action that answer belongs to. */
  @observable accessor lastAction: HarnessInstallAction | null = null

  constructor(
    readonly row: MachineHarness,
    readonly view: AgentSetupView,
  ) {}

  get kind(): BuiltinHarnessKind {
    return this.row.kind
  }
  get label(): string {
    return this.row.label
  }

  // Install facts

  /** A copy sessions can run: the person's (current enough) or Podium's active release. */
  @lazy get usable(): boolean {
    return (this.row.hasOwn && !this.row.tooOld) || !!this.row.managed?.active
  }
  @lazy get source(): AgentSetupSource | undefined {
    const podium = !!this.row.managed?.active
    const own = this.row.hasOwn
    if (podium && own) return 'both'
    if (podium) return 'podium'
    return own ? 'own' : undefined
  }
  @lazy get sourceLabel(): string | undefined {
    switch (this.source) {
      case 'podium':
        return 'Podium’s copy'
      case 'own':
        return this.row.tooOld ? 'Your install · too old for Podium' : 'Your install'
      case 'both':
        return 'Podium’s copy · your install too'
      default:
        return undefined
    }
  }
  /** The version sessions run: Podium's active release first, else the person's. */
  @lazy get version(): string | undefined {
    return this.row.managed?.active?.version ?? this.row.ownVersion
  }

  // Install in flight

  /** This opening sent an install (or retry) and has no answer yet. */
  @lazy get requesting(): boolean {
    return this.answer.loading && this.lastAction === 'install'
  }
  @lazy get installing(): boolean {
    return this.row.state === 'installing' || this.requesting
  }
  /** Install progress from the machine (POD-7471), while installing. */
  @lazy get progress(): AgentInstallProgress | undefined {
    return this.installing ? rowField<AgentInstallProgress>(this.row, 'progress') : undefined
  }
  @lazy get progressLabel(): string | undefined {
    if (this.row.state === 'installing') return this.row.managedLabel
    return this.requesting ? `Installing ${this.label}…` : undefined
  }

  // Failure

  /** Why the last install did not leave a usable copy; undefined when it did. */
  @lazy get failure(): string | undefined {
    if (this.usable || this.installing) return undefined
    if (this.lastAction === 'install') {
      const asked = this.answer.error ?? this.answer.answer?.error
      if (asked) return asked
    }
    const reported =
      rowField<HarnessLastError>(this.row, 'lastError')?.message ??
      this.row.managed?.lastError?.message
    if (reported) return reported
    if (this.row.managed?.currentFailed)
      return `Podium’s copy (${this.row.managed.currentFailed.version}) did not start on this machine.`
    return undefined
  }

  // Blocked

  @lazy get installable(): boolean {
    return this.row.inventory?.management?.installable !== false
  }
  /** Why Podium can't install this harness here, with the fix when there is one. */
  @lazy({ equals: compareShallowObject }) get blocked(): AgentSetupBlock | undefined {
    if (this.usable) return undefined
    if (this.row.state === 'unknown') {
      const probe = this.row.inventory?.probeError
      return this.row.inventory
        ? {
            reason: `Podium could not tell whether ${this.label} is installed here${probe ? ` (the check timed out after ${Math.ceil(probe.timeoutMs / 1000)}s)` : ''}.`,
            fix: 'The machine checks again on its next report.',
          }
        : {
            reason: `This machine does not report ${this.label}.`,
            fix: 'Update Podium on this machine.',
          }
    }
    if (this.installable) return undefined
    return {
      reason: this.row.installReason ?? `Podium can’t install ${this.label} on this machine.`,
      ...(this.row.hasOwn ? { fix: `Update your own ${this.label} install.` } : {}),
    }
  }
  /** Programs this harness needs here for one use (POD-7375): a warning, not a group. */
  @lazy({ equals: compareShallow }) get prerequisites(): readonly AgentSetupBlock[] {
    return (this.row.inventory?.missingPrerequisites ?? []).map((missing) => ({
      reason: missing.message,
      fix: `Install ${missing.package} on this machine.`,
    }))
  }

  // Sign-in

  readonly signIn: AgentSignIn = new AgentSignIn(this)

  // Where the panel puts it

  @lazy get status(): AgentSetupStatus {
    if (this.installing) return 'installing'
    if (this.failure) return 'failed'
    if (this.usable) return this.signIn.ready ? 'ready' : 'needs-sign-in'
    return this.blocked ? 'blocked' : 'not-installed'
  }
  /** Installed and either signed in or the person chose to sign in later. */
  @lazy get readyToStart(): boolean {
    return this.status === 'ready' || (this.status === 'needs-sign-in' && this.signIn.later)
  }

  // Actions on the list row

  @lazy get canAct(): boolean {
    return this.row.canAct && !this.answer.loading
  }
  @lazy get selectable(): boolean {
    return this.status === 'not-installed'
  }
  @lazy get selected(): boolean {
    return this.selectable && this.view.selection.has(this.kind)
  }
  @lazy get canInstall(): boolean {
    return (
      (this.status === 'not-installed' || this.status === 'failed') &&
      this.installable &&
      this.row.canAct &&
      !this.answer.loading
    )
  }
  @lazy get installLabel(): string {
    return this.status === 'failed' ? 'Try again' : this.row.actionLabel('install')
  }
  @lazy get canCancel(): boolean {
    return this.installing && (this.row.actions as readonly string[]).includes(CANCEL)
  }

  /** Install Podium's copy; also the retry of a failed install. */
  @action install(): void {
    if (!this.canInstall) return
    if (!this.view.focus) this.view.setFocus(this.kind)
    this.run('install')
  }
  @action retry(): void {
    this.install()
  }
  @action cancel(): void {
    if (!this.canCancel) return
    this.run(CANCEL)
  }

  /** Run one existing harness action; its answer stays on this item. */
  @action run(next: HarnessInstallAction, confirmedConversations?: string[]): void {
    this.lastAction = next
    void this.answer.run(this.view.client, this.row, next, confirmedConversations)
  }

  @action close(): void {
    this.answer.close()
    this.signIn.close()
  }
}

function compareShallowObject<T extends object | undefined>(a: T, b: T): boolean {
  if (a === b) return true
  if (!a || !b) return false
  const keys = Object.keys(a)
  if (keys.length !== Object.keys(b).length) return false
  return keys.every(
    (key) => (a as Record<string, unknown>)[key] === (b as Record<string, unknown>)[key],
  )
}

// ---------------------------------------------------------------------------
// Sign-in
// ---------------------------------------------------------------------------

export type AgentSignInChoiceKind = 'browser' | 'saved' | 'later'

export interface AgentSignInChoice {
  readonly kind: AgentSignInChoiceKind
  readonly title: string
  readonly detail: string
  readonly available: boolean
}

/** How one harness signs in: the machine's report plus the person's choice in this opening. */
export class AgentSignIn {
  @observable accessor later = false
  @observable accessor opening = false
  @observable accessor loginSessionId: SessionId | null = null
  @observable accessor error: string | null = null
  /** The saved credential being written, until the synced preference shows it. */
  @observableRef accessor savingCredential: string | null = null
  private sequence = 0

  constructor(private readonly item: AgentSetupItem) {}

  private get view(): AgentSetupView {
    return this.item.view
  }
  private get kind(): BuiltinHarnessKind {
    return this.item.kind
  }

  /** What the machine reports for this harness's own login. */
  @lazy get reported(): 'in' | 'out' | 'unknown' {
    return this.item.row.inventory?.login.state ?? 'unknown'
  }
  @lazy get account(): string | undefined {
    return this.item.row.inventory?.login.account
  }
  /** The person's saved default credential for this harness, if any. */
  @lazy get savedCredentialId(): string | undefined {
    return (
      this.view.preferences.credentialDefaults()[this.kind] ?? this.savingCredential ?? undefined
    )
  }
  @lazy get savedCredentialLabel(): string | undefined {
    const id = this.savedCredentialId
    if (!id) return undefined
    return this.savedCredentials.find((choice) => choice.id === id)?.label ?? 'A saved credential'
  }
  @lazy({ equals: compareShallow }) get savedCredentials(): readonly SavedCredentialChoice[] {
    return this.view.preferences.savedCredentials(this.kind)
  }

  /** A session started now would not stop at sign-in. */
  @lazy get ready(): boolean {
    return this.reported !== 'out' || this.savedCredentialId !== undefined
  }

  @lazy get state(): AgentSignInState {
    if (this.reported === 'in') return 'signed-in'
    if (this.savedCredentialId !== undefined) return 'saved-credential'
    if (this.reported === 'unknown') return 'unknown'
    if (this.opening) return 'opening'
    if (this.loginSessionId) return 'signing-in'
    if (this.later) return 'later'
    return 'signed-out'
  }

  @lazy get stateLabel(): string {
    switch (this.state) {
      case 'signed-in':
        return this.account ? `Signed in as ${this.account}` : 'Signed in'
      case 'saved-credential':
        return `Uses ${this.savedCredentialLabel ?? 'a saved credential'}`
      case 'unknown':
        return 'Sign-in is checked when a session starts'
      case 'opening':
        return 'Opening sign-in…'
      case 'signing-in':
        return 'Finish signing in in the terminal'
      case 'later':
        return 'Sessions ask you to sign in when they start'
      case 'signed-out':
        return 'Not signed in'
    }
  }

  @lazy({ equals: compareShallow }) get choices(): readonly AgentSignInChoice[] {
    const machine = this.view.machineName
    const label = this.item.label
    return [
      {
        kind: 'browser',
        title: 'Sign in with your browser',
        detail: `Opens ${label}’s own sign-in on ${machine}.`,
        available: this.item.row.canAct,
      },
      {
        kind: 'saved',
        title: 'Use a saved credential',
        detail: `Every ${label} session you start uses it, on any machine, not only ${machine}.`,
        available: this.savedCredentials.length > 0,
      },
      {
        kind: 'later',
        title: 'Later',
        detail: 'Nothing changes now. Sessions ask you to sign in when they start.',
        available: true,
      },
    ]
  }

  /** Open the harness's sign-in terminal on this machine (`credentials.login`). */
  @action async signInWithBrowser(): Promise<void> {
    if (this.opening || !this.item.row.canAct) return
    const sequence = ++this.sequence
    this.opening = true
    this.error = null
    this.later = false
    try {
      const { sessionId } = await this.view.client.credentials.login.mutate({
        harness: this.kind,
        machineId: this.view.machine.id,
      })
      runInAction(() => {
        if (sequence === this.sequence) this.loginSessionId = sessionId
      })
    } catch (cause) {
      runInAction(() => {
        if (sequence === this.sequence) this.error = answerError(cause)
      })
    } finally {
      runInAction(() => {
        if (sequence === this.sequence) this.opening = false
      })
    }
  }

  /** The person closed the sign-in terminal; the machine's next report decides. */
  @action closeLogin(): void {
    this.loginSessionId = null
  }

  /** Make a saved credential this harness's default for every session the person starts. */
  @action async useSavedCredential(credentialId: string): Promise<void> {
    if (!this.savedCredentials.some((choice) => choice.id === credentialId)) return
    const sequence = ++this.sequence
    this.error = null
    this.later = false
    this.savingCredential = credentialId
    try {
      await this.view.preferences.saveCredentialDefaults({
        ...this.view.preferences.credentialDefaults(),
        [this.kind]: credentialId,
      })
      // The synced preference carries it from here.
      runInAction(() => {
        if (sequence === this.sequence) this.savingCredential = null
      })
    } catch (cause) {
      runInAction(() => {
        if (sequence === this.sequence) {
          this.error = answerError(cause)
          this.savingCredential = null
        }
      })
    }
  }

  /** Sign in later: nothing is written; sessions ask at start. */
  @action chooseLater(): void {
    ++this.sequence
    this.later = true
    this.error = null
    this.opening = false
  }

  @action close(): void {
    ++this.sequence
    this.opening = false
    this.loginSessionId = null
  }
}

// ---------------------------------------------------------------------------
// Detail
// ---------------------------------------------------------------------------

export type AgentSetupSectionKey = 'install' | 'updates' | 'own' | 'home' | 'remove'

export interface AgentSetupSection {
  readonly key: AgentSetupSectionKey
  readonly title: string
  readonly actions: readonly HarnessInstallAction[]
}

/** Partial: an action a later protocol adds lands in Install rather than vanishing. */
const SECTION_OF: Readonly<Partial<Record<HarnessInstallAction, AgentSetupSectionKey>>> = {
  install: 'install',
  check: 'updates',
  back: 'updates',
  pause: 'updates',
  resume: 'updates',
  'take-settings': 'own',
  changes: 'own',
  'remove-changes': 'own',
  'home-info': 'home',
  'remove-home': 'home',
  remove: 'remove',
}
const SECTION_ORDER: readonly AgentSetupSectionKey[] = [
  'install',
  'updates',
  'own',
  'home',
  'remove',
]
const SECTION_TITLE: Readonly<Record<AgentSetupSectionKey, string>> = {
  install: 'Install',
  updates: 'Updates',
  own: 'Your own install',
  home: 'Podium home',
  remove: 'Remove',
}

/** One harness opened in the panel: its facts and every action today's Settings row has. */
export class AgentSetupDetail {
  @observable accessor confirmingRemove = false
  @observable accessor confirmingRemoveHome = false

  constructor(readonly item: AgentSetupItem) {}

  private get row(): MachineHarness {
    return this.item.row
  }
  private get answer(): HarnessActionResult | undefined {
    return this.item.answer.answer
  }

  // Facts

  @lazy get podiumVersion(): string | undefined {
    return this.row.managed?.active?.version
  }
  @lazy get ownVersion(): string | undefined {
    return this.row.hasOwn ? this.row.ownVersion : undefined
  }
  /** The person's install with its version and too-old note (Settings row wording). */
  @lazy get ownLabel(): string | undefined {
    return this.row.ownLabel
  }
  @lazy get podiumLabel(): string | undefined {
    return this.row.managedLabel
  }
  @lazy get latestVersion(): string | undefined {
    return this.row.managed?.latest
  }
  @lazy get lastCheckAt(): string | undefined {
    return this.row.state === 'installing' ? undefined : this.row.managed?.lastCheckAt
  }
  @lazy get updateNotice(): string | undefined {
    return this.row.updateNotice
  }
  @lazy get installReason(): string | undefined {
    return this.row.managed ? undefined : this.row.installReason
  }
  @lazy get sharingWarning(): string | undefined {
    return this.row.sharing
      ? 'Both installs are sharing one folder for settings and conversations.'
      : undefined
  }
  @lazy get ledgerNotice(): string | undefined {
    return this.row.inventory?.install?.ledgerRebuilt
      ? 'Podium rebuilt the install record from the releases on this machine.'
      : undefined
  }
  @lazy get lastError(): string | undefined {
    return this.row.managed?.lastError?.message
  }

  // Updates

  /** Podium updates its copy itself; undefined when it does not manage updates (vendor or no copy). */
  @lazy get autoUpdate(): boolean | undefined {
    if (!this.row.managed || this.row.managed.vendorUpdated) return undefined
    return !this.row.managed.paused
  }
  @lazy get vendorUpdated(): boolean {
    return this.row.managed?.vendorUpdated === true
  }

  // Actions

  /** Every MachineHarness action, grouped; none is dropped. */
  @lazy({ equals: compareShallowSections }) get sections(): readonly AgentSetupSection[] {
    const byKey = new Map<AgentSetupSectionKey, HarnessInstallAction[]>()
    for (const next of this.row.actions) {
      // Cancel belongs to the installing row in the list, not to the harness page.
      if (next === CANCEL) continue
      const key = SECTION_OF[next] ?? 'install'
      byKey.set(key, [...(byKey.get(key) ?? []), next])
    }
    if (this.answer?.homeExists && this.answer.conversations) {
      byKey.set('home', [...(byKey.get('home') ?? []), 'remove-home'])
    }
    return SECTION_ORDER.flatMap((key) => {
      const actions = byKey.get(key)
      return actions ? [{ key, title: SECTION_TITLE[key], actions }] : []
    })
  }

  label(next: HarnessInstallAction): string {
    if (next === 'install' && this.item.status === 'failed') return 'Try again'
    if (next === 'pause') return 'Turn off automatic updates'
    if (next === 'resume') return 'Turn on automatic updates'
    return this.row.actionLabel(next)
  }

  disabled(next: HarnessInstallAction): boolean {
    if (!this.item.canAct) return true
    if (next === 'install') return !this.item.installable
    return false
  }

  /** A press on one action: remove and home removal ask first. */
  @action press(next: HarnessInstallAction): void {
    if (this.disabled(next)) return
    if (next === 'remove') {
      this.confirmingRemove = true
      return
    }
    if (next === 'remove-home') {
      if (this.removeHomeConfirmation) this.confirmingRemoveHome = true
      return
    }
    this.item.run(next)
  }

  // Remove

  @lazy get removeConfirmation(): string {
    return `Remove Podium’s copy of ${this.item.label}? Releases will be deleted once their running sessions exit. Your Podium home, conversations and sign-in folders will stay.`
  }
  @action confirmRemove(): void {
    this.confirmingRemove = false
    this.item.run('remove')
  }
  @action cancelRemove(): void {
    this.confirmingRemove = false
  }
  /** The remove answer's running-sessions note. */
  @lazy get pendingSessionsNote(): string | undefined {
    const count = this.item.lastAction === 'remove' ? this.answer?.pendingSessions : undefined
    if (!count) return undefined
    return `Removal is waiting for ${count} running ${count === 1 ? 'session' : 'sessions'}. Homes and conversations are kept.`
  }

  // Answers from the action this detail ran

  @lazy get waiting(): boolean {
    return this.item.answer.loading
  }
  @lazy get error(): string | undefined {
    return this.item.answer.error ?? this.answer?.error ?? undefined
  }
  /** `changes` / `remove-changes`: Podium's edits in the person's own folder. */
  @lazy get changes(): HarnessActionResult['changes'] {
    return this.answer?.changes
  }
  /** `home-info`: whether the Podium home exists and the conversations it holds. */
  @lazy get home():
    | { exists: boolean; conversations: NonNullable<HarnessActionResult['conversations']> }
    | undefined {
    const conversations = this.answer?.conversations
    return conversations ? { exists: this.answer?.homeExists === true, conversations } : undefined
  }
  @lazy get removeHomeConfirmation(): string | undefined {
    const home = this.home
    if (!home?.exists) return undefined
    const titles = home.conversations.map((conversation) => conversation.title)
    return `Delete the Podium home of ${this.item.label}? This deletes these conversations: ${titles.length ? titles.join(', ') : '(none)'}. Your sign-in folders stay.`
  }
  @action cancelRemoveHome(): void {
    this.confirmingRemoveHome = false
  }
  /** Delete the Podium home, naming the conversations the person was shown. */
  @action confirmRemoveHome(): void {
    this.confirmingRemoveHome = false
    const home = this.home
    if (!home?.exists || !this.item.canAct) return
    this.item.run(
      'remove-home',
      home.conversations.map((conversation) => conversation.id),
    )
  }
}

function compareShallowSections(
  a: readonly AgentSetupSection[],
  b: readonly AgentSetupSection[],
): boolean {
  return (
    a.length === b.length &&
    a.every(
      (section, index) =>
        section.key === b[index]?.key && compareShallow(section.actions, b[index]?.actions),
    )
  )
}

// ---------------------------------------------------------------------------
// The panel
// ---------------------------------------------------------------------------

export type AgentSetupPrimary =
  | { readonly kind: 'done'; readonly label: string }
  | { readonly kind: 'start'; readonly label: string; readonly enabled: boolean }

/** One opening of the "Set up agents" panel for one machine. */
export class AgentSetupView {
  readonly machine: MachineModel
  readonly client: AgentSetupOptions['client']
  readonly preferences: AgentSetupPreferences
  readonly origin: AgentSetupOrigin
  /**
   * The harness the opener gets back from "Start <harness>". A menu may name one when it
   * opens the panel; "Set up agents…" names none, so the first harness the person
   * installs here becomes the focus, and {@link setFocus} retargets it.
   */
  @observable accessor focus: BuiltinHarnessKind | undefined = undefined
  /** Kinds the person ticked; only not-installed harnesses count (see {@link selectedKinds}). */
  readonly selection = observable.set<BuiltinHarnessKind>()
  @observable accessor detailKind: BuiltinHarnessKind | null = null

  readonly item = companion((row: MachineHarness) => new AgentSetupItem(row, this))
  readonly detailOf = companion((item: AgentSetupItem) => new AgentSetupDetail(item))

  constructor(options: AgentSetupOptions) {
    this.machine = options.machine
    this.client = options.client
    this.preferences = options.preferences
    this.origin = options.origin
    this.focus = options.focus
    // A menu asked about this harness: tick it, so one press installs it. Nothing runs yet.
    const focused = this.focusItem
    if (focused?.selectable) this.selection.add(focused.kind)
  }

  @lazy get machineName(): string {
    return this.machine.name || 'this machine'
  }
  /** The machine can take actions now (online and the person may use it). */
  @lazy get reachable(): boolean {
    return this.machine.online && this.machine.use === 'granted'
  }
  /** No inventory yet: the panel says it is checking instead of showing groups. */
  @lazy get checking(): boolean {
    return this.machine.inventory === undefined
  }

  @lazy({ equals: compareShallow }) get items(): readonly AgentSetupItem[] {
    if (this.checking) return []
    return this.machine.harnessInstalls.map((row) => this.item(row))
  }
  itemFor(kind: BuiltinHarnessKind): AgentSetupItem | undefined {
    return this.items.find((item) => item.kind === kind)
  }

  // Groups

  @lazy({ equals: compareShallowGroups }) get groups(): readonly AgentSetupGroup[] {
    return AGENT_SETUP_GROUP_ORDER.flatMap((status) => {
      const items = this.items.filter((item) => item.status === status)
      return items.length ? [{ status, title: AGENT_SETUP_GROUP_TITLE[status], items }] : []
    })
  }
  /** "2 ready · 1 installing · 1 needs sign-in · 2 not installed". */
  @lazy get summary(): string {
    const counts = new Map<AgentSetupStatus, number>()
    for (const item of this.items) counts.set(item.status, (counts.get(item.status) ?? 0) + 1)
    return SUMMARY_ORDER.flatMap((status) => {
      const count = counts.get(status)
      return count ? [`${count} ${SUMMARY_WORDS[status]}`] : []
    }).join(' · ')
  }

  // Selection

  @lazy({ equals: compareShallow }) get selectedKinds(): readonly BuiltinHarnessKind[] {
    return this.items.filter((item) => item.selected).map((item) => item.kind)
  }
  @lazy get canInstallSelected(): boolean {
    return this.selectedKinds.some((kind) => this.itemFor(kind)?.canInstall)
  }
  @lazy get installSelectedLabel(): string {
    const count = this.selectedKinds.length
    return count > 1 ? `Install ${count} selected` : 'Install selected'
  }
  @action toggle(kind: BuiltinHarnessKind): void {
    if (this.selection.has(kind)) this.selection.delete(kind)
    else if (this.itemFor(kind)?.selectable) this.selection.add(kind)
  }
  @action selectAllNotInstalled(): void {
    for (const item of this.items) if (item.selectable) this.selection.add(item.kind)
  }
  @action clearSelection(): void {
    this.selection.clear()
  }
  /** Install every ticked harness at once; each install has its own answer. */
  @action installSelected(): void {
    const kinds = this.selectedKinds
    if (!this.focus && kinds.length > 0) this.focus = kinds[0]
    for (const kind of kinds) this.itemFor(kind)?.install()
    this.selection.clear()
  }

  // Detail

  @lazy get detail(): AgentSetupDetail | undefined {
    const item = this.detailKind ? this.itemFor(this.detailKind) : undefined
    return item ? this.detailOf(item) : undefined
  }
  @action openDetail(kind: BuiltinHarnessKind): void {
    this.detailKind = kind
  }
  @action closeDetail(): void {
    this.detailKind = null
  }

  // Hand-back

  /** Point "Start <harness>" at another harness of this machine. */
  @action setFocus(kind: BuiltinHarnessKind | undefined): void {
    this.focus = kind
  }
  @lazy get focusItem(): AgentSetupItem | undefined {
    return this.focus ? this.itemFor(this.focus) : undefined
  }
  /** The opener can start the focused harness now. Settings has nothing to start. */
  @lazy get canStart(): boolean {
    return (
      this.origin.kind !== 'settings' &&
      this.origin.onStart !== undefined &&
      this.focusItem?.readyToStart === true
    )
  }
  @lazy get primary(): AgentSetupPrimary {
    const focused = this.focusItem
    if (this.origin.kind === 'settings' || !this.origin.onStart || !focused) {
      return { kind: 'done', label: 'Done' }
    }
    return { kind: 'start', label: `Start ${focused.label}`, enabled: this.canStart }
  }
  /** Hand the focused harness back to the menu or onboarding step that opened the panel. */
  @action start(): void {
    if (!this.canStart || !this.focus) return
    this.origin.onStart?.(this.focus)
  }

  /** The panel closed: drop every answer and pending sign-in of this opening. */
  @action close(): void {
    for (const item of this.items) item.close()
    this.selection.clear()
    this.detailKind = null
  }
}

function compareShallowGroups(
  a: readonly AgentSetupGroup[],
  b: readonly AgentSetupGroup[],
): boolean {
  return (
    a.length === b.length &&
    a.every(
      (group, index) =>
        group.status === b[index]?.status && compareShallow(group.items, b[index]?.items),
    )
  )
}
