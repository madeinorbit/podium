import { MemberDirectory } from '@podium/client-graph/member-directory'
import type { MobxPool } from '@podium/client-graph/pool'
import { RequestAnswer } from '@podium/client-graph/request-answer'
import type { MemberModel } from '@podium/client-graph/requested-models'
import { companion, lazy } from '@podium/mobx-helpers'
import { compareShallow } from 'mobx'
import { SettingsMachines } from '../settings-machine-readers'

/** Public sign-in metadata from the existing admin Access answer; never credentials. */
export interface MemberSignInsAnswer {
  signInsTotal?: number
  signIns: {
    id?: string | null
    memberId: string
    kind: string
    deviceName: string | null
    platform: string | null
    createdAt: string
    lastSeenAt: string | null
    expiresAt: string
  }[]
}

export class MembersPage extends MemberDirectory {
  readonly devices = new RequestAnswer<MemberSignInsAnswer>()
  readonly machines: SettingsMachines
  readonly person = companion((member: MemberModel) => new SettingsPerson(member, this))

  constructor(pool: MobxPool) {
    super(pool)
    this.machines = new SettingsMachines(pool)
  }

  @lazy get devicesTruncated(): boolean {
    const answer = this.devices.answer
    return Boolean(answer && (answer.signInsTotal ?? answer.signIns.length) > answer.signIns.length)
  }

  override dispose(): void {
    this.devices.close()
    super.dispose()
  }
}

/** Rules of the Members page for one shared member model. */
export class SettingsPerson {
  constructor(readonly member: MemberModel, private readonly page: MembersPage) {}

  @lazy get self(): boolean {
    return this.member.id === this.page.currentMemberId
  }

  @lazy get initials(): string {
    return this.member.displayName.trim().split(/\s+/u).slice(0, 2).map((word) => word[0]).join('').toLocaleUpperCase()
  }

  @lazy({ equals: compareShallow }) get devices() {
    return (this.page.devices.answer?.signIns ?? []).filter((signIn) => signIn.memberId === this.member.id)
  }

  @lazy({ equals: compareShallow }) get machines() {
    return this.page.machines.values.filter((machine) => machine.custodian === this.member.id)
  }

  allows(action: string): boolean {
    return this.page.actionsFor(this.member.id).includes(action)
  }
}

export const MEMBER_ROLE_OPTIONS = [
  { value: 'member', label: 'Member' },
  { value: 'admin', label: 'Admin' },
] as const

export const memberRoleLabel = (role: string): string => role === 'admin' ? 'Admin' : 'Member'

export const deviceLabel = (device: MemberSignInsAnswer['signIns'][number]): string =>
  device.deviceName || ({ login: 'Browser or desktop', mobile: 'Phone', upstream: 'Upstream link', 'break-glass': 'Host recovery' }[device.kind] ?? device.kind)
