import { describe, expect, it, vi } from 'vitest'
import { UpdatesService } from './service'
import { fleetSnapshot } from './trpc'

/**
 * WHAT THE PANEL IS ALLOWED TO OFFER (POD-2783).
 *
 * A human connected a macOS desktop app to a Linux-only sandbox, was offered an
 * update, accepted it, and was refused — because the release had been minted
 * before that Mac existed and its platform list is fixed at mint time. The
 * refusal was correct. Being offered the action at all was the defect.
 *
 * This read model is where the offer comes from: no `behind` machine, no
 * machines row, no button. Its own contract says the set it counts is the set
 * `updates.start` would grant, so a machine the plan defers must not be counted
 * here — otherwise the offer and the operation describe different fleets, which
 * is the disagreement POD-2222 closed one axis over.
 */
const feedTarget = (platforms: readonly string[]) =>
  ({
    version: '0.4.2',
    critical: false,
    artifacts: {
      headless: {
        delivery: 'feed',
        platforms: Object.fromEntries(
          platforms.map((platform) => [
            platform,
            { url: `https://x.test/${platform}.tgz`, digest: 'd', signature: 's' },
          ]),
        ),
      },
    },
  }) as never

const machine = (id: string, over: Record<string, unknown> = {}) => ({
  id,
  name: id,
  version: '0.4.1',
  state: 'current',
  online: true,
  busy: false,
  deliveryCaps: ['update.delivery.feed'],
  ...over,
})

function serviceFor(machines: unknown[], platforms: readonly string[]) {
  const svc = new UpdatesService({
    machines: () => machines as never,
    send: vi.fn(),
    now: () => 1_000,
    nextGrantId: () => 'g1',
    concurrency: 3,
    fleetChannel: () => 'dev',
  })
  svc.setTarget('dev', feedTarget(platforms))
  return svc
}

describe('the update offer', () => {
  it('does not count a machine the release predates as behind', () => {
    const svc = serviceFor(
      [
        machine('vps', { platform: 'linux-x86_64' }),
        machine('mac', { platform: 'darwin-aarch64' }),
      ],
      ['linux-x86_64'],
    )
    const snapshot = fleetSnapshot(svc)
    expect(snapshot.behind).toBe(1)
    expect(snapshot.machines.map((row) => row.id)).toEqual(['vps'])
  })

  /** It is still a machine. Settings shows every row, whatever this wave grants. */
  it('keeps it in the full inventory Settings renders', () => {
    const svc = serviceFor([machine('mac', { platform: 'darwin-aarch64' })], ['linux-x86_64'])
    expect(fleetSnapshot(svc).allMachines.map((row) => row.id)).toEqual(['mac'])
  })

  it('offers nothing at all when the only behind machine is one the release predates', () => {
    const svc = serviceFor([machine('mac', { platform: 'darwin-aarch64' })], ['linux-x86_64'])
    expect(fleetSnapshot(svc).behind).toBe(0)
  })

  it('still offers the release to the machines it was built for', () => {
    const svc = serviceFor([machine('vps', { platform: 'linux-x86_64' })], ['linux-x86_64'])
    expect(fleetSnapshot(svc).behind).toBe(1)
  })

  /** A machine that has never reported a platform stays visible, as with caps. */
  it('counts a machine that has reported no platform', () => {
    const svc = serviceFor([machine('mute')], ['linux-x86_64'])
    expect(fleetSnapshot(svc).behind).toBe(1)
  })
})
