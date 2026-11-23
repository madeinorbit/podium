import {
  BUNDLED_DESCRIPTORS,
  gateHarnessVersion,
  HARNESS_VERSION_POLICIES,
  type HarnessVersionPolicy,
} from '@podium/harness/browser'
import { lazy } from '@podium/mobx-helpers'
import type { BuiltinHarnessKind, HarnessInstallProgress } from '@podium/model'
import { CAP_HARNESS_INSTALL_CANCEL, type HarnessInstallAction } from '@podium/protocol'
import { compareShallow } from 'mobx'
import type { MachineModel } from './synced-models'

/** A running install as the machine reports it (POD-7471). */
export interface MachineHarnessProgress {
  phase: HarnessInstallProgress['phase']
  /** Whole percent of the current download; only while the vendor named its size. */
  percent?: number
  receivedBytes?: number
  totalBytes?: number
}

/** The last failed check or install of Podium's copy. */
export interface MachineHarnessError {
  message: string
  at: string
  version?: string
}

/** One harness's facts, always read from its shared machine model. No inventory copy. */
export class MachineHarness {
  constructor(
    readonly machine: MachineModel,
    readonly kind: BuiltinHarnessKind,
  ) {}
  @lazy get label(): string {
    return BUNDLED_DESCRIPTORS.find((row) => row.kind === this.kind)?.label ?? this.kind
  }
  @lazy get inventory() {
    return this.machine.inventory?.agents.find((row) => row.kind === this.kind)
  }
  @lazy get managed() {
    return this.inventory?.install?.managed
  }
  @lazy get ownVersion(): string | undefined {
    return (
      this.inventory?.install?.external?.version ??
      (!this.managed ? this.inventory?.version : undefined)
    )
  }
  @lazy get hasOwn(): boolean {
    return (
      !!this.inventory?.install?.external || (!this.managed && this.inventory?.installed === true)
    )
  }
  @lazy get tooOld(): boolean {
    const policy = (HARNESS_VERSION_POLICIES as Record<string, HarnessVersionPolicy>)[this.kind]
    return (
      !!policy && !!this.ownVersion && gateHarnessVersion(policy, this.ownVersion) === 'too-old'
    )
  }
  @lazy get sharing(): boolean {
    return (
      !!this.managed &&
      this.hasOwn &&
      this.inventory?.management !== undefined &&
      !this.inventory.management.homeVariable
    )
  }
  @lazy get state():
    | 'unknown'
    | 'not-installed'
    | 'own'
    | 'own-too-old'
    | 'managed'
    | 'both'
    | 'shared'
    | 'installing'
    | 'removing' {
    if (this.managed?.installing) return 'installing'
    if (this.managed?.removingAt) return 'removing'
    if (this.sharing) return 'shared'
    if (this.managed && this.hasOwn) return 'both'
    if (this.managed) return 'managed'
    if (!this.inventory || this.inventory.installed === null) return 'unknown'
    if (!this.hasOwn) return 'not-installed'
    return this.tooOld ? 'own-too-old' : 'own'
  }
  /**
   * Where a running install is. Undefined unless installing on a machine that
   * reports progress: older daemons report only that an install runs.
   */
  @lazy({ equals: compareShallow }) get progress(): MachineHarnessProgress | undefined {
    if (this.state !== 'installing') return undefined
    const progress = this.managed?.installing?.progress
    if (!progress) return undefined
    const { phase, receivedBytes, totalBytes } = progress
    return {
      phase,
      ...(receivedBytes !== undefined ? { receivedBytes } : {}),
      ...(totalBytes !== undefined ? { totalBytes } : {}),
      ...(phase === 'download' && totalBytes
        ? { percent: Math.min(100, Math.floor(((receivedBytes ?? 0) / totalBytes) * 100)) }
        : {}),
    }
  }
  /** The last failed check or install of Podium's copy, for any UI to show. */
  @lazy({ equals: compareShallow }) get lastError(): MachineHarnessError | undefined {
    const error = this.managed?.lastError
    if (!error) return undefined
    return {
      message: error.message,
      at: error.at,
      ...(error.version !== undefined ? { version: error.version } : {}),
    }
  }
  /** A running install can be stopped: the machine says it supports a cancel. */
  @lazy get canCancel(): boolean {
    return (
      this.state === 'installing' &&
      this.machine.online &&
      this.machine.use === 'granted' &&
      (this.machine.deliveryCaps?.includes(CAP_HARNESS_INSTALL_CANCEL) ?? false)
    )
  }
  /** Podium manages this harness but has no release that runs: a failed first install. */
  @lazy get noUsableRelease(): boolean {
    return !!this.managed && !this.managed.active && !this.managed.removingAt
  }
  @lazy get ownLabel(): string | undefined {
    return this.hasOwn
      ? `${this.ownVersion ?? 'Version unknown'} · your install${this.tooOld ? ' · too old for Podium' : ''}`
      : undefined
  }
  @lazy get managedLabel(): string | undefined {
    if (this.state === 'installing')
      return `Installing${this.managed?.installing?.version ? ` ${this.managed.installing.version}` : ''}…`
    if (this.state === 'removing') return 'Removing Podium’s copy when its running sessions exit'
    if (!this.managed) return undefined
    if (this.managed.vendorUpdated)
      return `${this.managed.active?.version ?? 'No usable release'} · installed by Podium · vendor updates`
    return `${this.managed.active?.version ?? 'No usable release'} · managed by Podium${this.managed.paused ? ' · updates paused' : ''}`
  }
  @lazy get installReason(): string | undefined {
    return this.inventory?.management?.reason
  }
  @lazy get updateNotice(): string | undefined {
    return this.managed ? this.inventory?.management?.updateNotice : undefined
  }
  /** The row's actions can run. While installing only `cancel-install` can, gated by {@link canCancel}. */
  @lazy get canAct(): boolean {
    return (
      this.machine.online &&
      this.machine.use === 'granted' &&
      !['installing', 'removing'].includes(this.state)
    )
  }
  @lazy({ equals: compareShallow }) get actions(): readonly HarnessInstallAction[] {
    if (this.state === 'installing') return this.canCancel ? ['cancel-install'] : []
    if (this.state === 'removing') return []
    if (this.state === 'shared') return ['remove']
    const actions: HarnessInstallAction[] = []
    // A failed first install leaves the row with no release: offer it again.
    if (!this.managed || this.noUsableRelease) actions.push('install')
    if (this.managed) {
      if (!this.managed.vendorUpdated) actions.push('check')
      if (this.managed.previousVersion) actions.push('back')
      if (!this.managed.vendorUpdated) actions.push(this.managed.paused ? 'resume' : 'pause')
      if (this.inventory?.management?.homeVariable) actions.push('take-settings')
      actions.push('remove')
    }
    if (this.hasOwn) actions.push('changes', 'remove-changes')
    if (this.inventory?.management?.homeVariable) actions.push('home-info')
    return actions
  }
  actionLabel(action: HarnessInstallAction): string {
    switch (action) {
      case 'home-info':
        return 'Podium home…'
      case 'remove-home':
        return 'Delete Podium home'
      case 'install':
        if (this.noUsableRelease) return this.lastError ? 'Try again' : 'Install'
        return this.tooOld
          ? 'Install a current version'
          : this.hasOwn
            ? 'Install for Podium'
            : 'Install'
      case 'cancel-install':
        return 'Cancel install'
      case 'check':
        return 'Check now'
      case 'back':
        return `Go back to ${this.managed?.previousVersion ?? 'previous release'}`
      case 'pause':
        return 'Pause updates'
      case 'resume':
        return 'Resume updates'
      case 'take-settings':
        return 'Take my settings'
      case 'remove-changes':
        return 'Remove Podium’s changes'
      case 'changes':
        return 'Show Podium’s changes'
      case 'remove':
        return this.sharing ? 'Remove Podium’s copy' : 'Remove'
    }
  }
}
