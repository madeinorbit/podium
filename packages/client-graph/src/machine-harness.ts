import {
  BUNDLED_DESCRIPTORS,
  gateHarnessVersion,
  HARNESS_VERSION_POLICIES,
  type HarnessVersionPolicy,
} from '@podium/harness/browser'
import { lazy } from '@podium/mobx-helpers'
import type { BuiltinHarnessKind } from '@podium/model'
import type { HarnessInstallAction } from '@podium/protocol'
import { compareShallow } from 'mobx'
import type { MachineModel } from './synced-models'

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
    return `${this.managed.active?.version ?? 'No usable release'} · managed by Podium${this.managed.paused ? ' · updates paused' : ''}`
  }
  @lazy get installReason(): string | undefined {
    return this.inventory?.management?.reason
  }
  @lazy get canAct(): boolean {
    return (
      this.machine.online &&
      this.machine.use === 'granted' &&
      !['installing', 'removing'].includes(this.state)
    )
  }
  @lazy({ equals: compareShallow }) get actions(): readonly HarnessInstallAction[] {
    if (this.state === 'installing' || this.state === 'removing') return []
    if (this.state === 'shared') return ['remove']
    const actions: HarnessInstallAction[] = []
    if (!this.managed) actions.push('install')
    if (this.managed) {
      actions.push('check')
      if (this.managed.previousVersion) actions.push('back')
      actions.push(this.managed.paused ? 'resume' : 'pause')
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
        return this.tooOld
          ? 'Install a current version'
          : this.hasOwn
            ? 'Install for Podium'
            : 'Install'
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
