import { RequestAnswer } from '@podium/client-graph/request-answer'
import { lazy } from '@podium/mobx-helpers'
import { UpdateSpacePreview } from '@podium/protocol'
import { action, compareShallow, observable } from 'mobx'

export function formatSpaceBytes(bytes: number): string {
  return bytes >= 1024 ** 3
    ? `${(bytes / 1024 ** 3).toFixed(1)} GiB`
    : `${Math.ceil(bytes / 1024 ** 2)} MiB`
}

/** A request answer owned only by the visible informational surface. */
export class UpdateSpaceView extends RequestAnswer<UpdateSpacePreview> {
  @observable accessor stale = false
  private expiry: ReturnType<typeof setTimeout> | undefined
  private request = 0

  constructor(private readonly read: () => Promise<unknown>) {
    super(() => 'Disk space could not be verified.')
  }

  @action refresh = async (): Promise<void> => {
    const request = ++this.request
    clearTimeout(this.expiry)
    this.stale = false
    await this.load(this.read, true, (raw) => UpdateSpacePreview.parse(raw))
    // A single deadline, no polling. Expiry never starts another machine check.
    if (request === this.request && this.answer) this.expiry = setTimeout(this.expire, 30_000)
  }

  @action private expire = (): void => {
    this.stale = true
  }

  override close(): void {
    ++this.request
    clearTimeout(this.expiry)
    super.close()
  }

  @lazy get summary(): string {
    if (this.loading) return 'Estimating disk space…'
    if (this.warnings.length) return 'Storage details'
    if (this.error || this.unverified) return 'Disk space could not be verified.'
    if (this.enoughCount) return 'Disk space looks sufficient'
    return 'No pending machine updates'
  }

  @lazy({ equals: compareShallow }) get warnings(): string[] {
    return (this.answer?.machines ?? []).flatMap((machine) => {
      if (machine.status !== 'low') return []
      const volume = machine.volumes.reduce<(typeof machine.volumes)[number] | undefined>(
        (worst, current) =>
          !worst || current.shortfallBytes > worst.shortfallBytes ? current : worst,
        undefined,
      )
      if (!volume) return []
      return [
        `Low disk space on ${machine.name}: ${formatSpaceBytes(volume.availableBytes)} available; ` +
          `about ${formatSpaceBytes(volume.requiredBytes)} needed. This update is likely to fail.`,
      ]
    })
  }

  @lazy get unverified(): string {
    return (this.answer?.machines ?? [])
      .filter((machine) => machine.status === 'unknown')
      .map((machine) => machine.name)
      .join(', ')
  }

  @lazy get enoughCount(): number {
    return (this.answer?.machines ?? []).filter((machine) => machine.status === 'enough').length
  }
}
