import type { MachineModel } from '@podium/client-graph'
import { companion, lazy } from '@podium/mobx-helpers'
import { compareShallow } from 'mobx'

export class MachinesSettings {
  readonly row = companion((machine: MachineModel) => new SettingsMachine(machine))
  constructor(private readonly machines: readonly MachineModel[], readonly admin: boolean) {}

  @lazy({ equals: compareShallow }) get visible(): readonly MachineModel[] {
    return this.admin ? this.machines : this.machines.filter((machine) =>
      machine.owned === true || machine.use === 'granted')
  }
}

export class MachineReplacementOptions {
  constructor(readonly machine: MachineModel, private readonly machines: readonly MachineModel[]) {}
  @lazy({ equals: compareShallow }) get candidates(): readonly MachineModel[] {
    return this.machines.filter((candidate) => candidate.id !== this.machine.id &&
      !candidate.revokedAt && !candidate.supersededBy && candidate.supersedable === true)
  }
}

/** The settings page's reading of a machine; the record remains the shared model. */
export class SettingsMachine {
  constructor(readonly machine: MachineModel) {}

  @lazy get canManage(): boolean {
    return this.machine.transferable === true && !this.machine.revokedAt && !this.machine.supersededBy
  }

  @lazy get canReplace(): boolean {
    return this.canManage && this.machine.supersedable === true
  }

  @lazy get runsServer(): boolean {
    return this.machine.hostsServer === true || this.machine.serviceAssignment?.server === true
  }

  @lazy get agentChangesOnRestart(): boolean {
    const service = this.machine.services?.agentExecution
    return service?.reason === 'changes on restart' ||
      (service?.policy === 'disabled' && service.state === 'available')
  }

  @lazy get serverChangesOnRestart(): boolean {
    const service = this.machine.services?.server
    return service?.reason === 'changes on restart' ||
      (service?.policy === 'disabled' && service.state === 'available')
  }

  @lazy({ equals: compareShallow }) get degradedServices(): readonly string[] {
    if (!this.machine.online) return []
    const { serviceAssignment: assignment, services } = this.machine
    return [
      ...(assignment?.server === true && services?.server.state !== 'available' &&
        !this.serverChangesOnRestart ? ['server'] : []),
      ...(assignment?.agentExecution === true && services?.agentExecution.policy !== 'disabled' &&
        services?.agentExecutionLockout !== true && !this.agentChangesOnRestart &&
        services?.agentExecution.state !== 'available' ? ['agents'] : []),
    ]
  }

  @lazy get status(): { label: string; tone: 'online' | 'offline' | 'degraded' | 'off'; detail?: string } {
    const { machine } = this
    if (machine.supersededBy) return { label: 'Replaced', tone: 'offline' }
    if (machine.revokedAt) return { label: 'Removed', tone: 'offline' }
    if (machine.onlineKnown === false) return { label: 'Status unknown', tone: 'offline' }
    if (!machine.online) return { label: 'Offline', tone: 'offline' }
    if (machine.daemonReadiness && machine.daemonReadiness.state !== 'ready') {
      return {
        label: `Not ready · ${machine.daemonReadiness.reason}`,
        tone: 'degraded',
        detail: `${machine.daemonReadiness.quarantinedBindings} quarantined`,
      }
    }
    if (this.degradedServices.length > 0) {
      return {
        label: `Online · Degraded: ${this.degradedServices.join(', ')}`,
        tone: 'degraded',
        detail: this.degradedServices.map((name) => name === 'server'
          ? machine.services?.server.reason : machine.services?.agentExecution.reason)
          .filter(Boolean).join('; ') || 'Assigned service is not available',
      }
    }
    if (machine.services?.agentExecution.state !== 'available' &&
      (machine.serviceAssignment?.agentExecution === false ||
        machine.services?.agentExecution.policy === 'disabled' ||
        machine.services?.agentExecutionLockout === true || this.agentChangesOnRestart)) {
      return {
        label: 'Online · Agent hosting off',
        tone: 'off',
        detail: machine.services?.agentExecutionLockout === true
          ? 'Disabled by local policy'
          : this.agentChangesOnRestart && machine.serviceAssignment?.agentExecution === true
            ? 'Enabled on restart' : 'Disabled on this machine',
      }
    }
    return { label: 'Online', tone: 'online' }
  }

  @lazy get componentsNote(): string | null {
    const components = this.machine.components
    if (components === undefined || components.includes('daemon')) return null
    if (components.length === 0) return 'Waiting for first connection'
    return components.includes('server')
      ? 'Server only. It cannot host projects or run agents.' : 'No agent service installed.'
  }
}
