import type { MachineWire } from '@podium/model'
import { asMachineId } from '@podium/model'
import { act, renderHook, waitFor } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import type { Store } from '@/app/store'
import { findNewMachine, useMachinePairing } from './machine-pairing'

function machine(id: string, online = true): MachineWire {
  return {
    id: asMachineId(id),
    name: id,
    hostname: `${id}.local`,
    online,
    lastSeenAt: Date.now(),
  } as MachineWire
}

function trpcWithPairing(
  pairingCode = vi.fn().mockResolvedValue({ code: 'PAIR-CODE', joinCommand: 'podium join' }),
  setupInfo = vi.fn().mockResolvedValue({ publicUrl: 'https://podium.example.com' }),
): Store['trpc'] {
  return {
    machines: { pairingCode: { mutate: pairingCode } },
    setup: { info: { query: setupInfo } },
  } as unknown as Store['trpc']
}

describe('machine pairing controller', () => {
  it('mints credential-aware pairing state with setup reachability', async () => {
    const pairingCode = vi
      .fn()
      .mockResolvedValue({ code: 'PAIR-CODE', joinCommand: 'podium join --code PAIR-CODE' })
    const setupInfo = vi.fn().mockResolvedValue({ publicUrl: 'https://podium.example.com' })
    const { result } = renderHook(() =>
      useMachinePairing({ trpc: trpcWithPairing(pairingCode, setupInfo), machines: [] }),
    )

    await act(() => result.current.mint({ podiumManaged: false }))

    expect(pairingCode).toHaveBeenCalledWith({
      copyAgentCredentials: true,
      podiumManaged: false,
    })
    expect(setupInfo).toHaveBeenCalledOnce()
    expect(result.current).toMatchObject({
      pairingCode: 'PAIR-CODE',
      joinCommand: 'podium join --code PAIR-CODE',
      publicUrl: 'https://podium.example.com',
      podiumManaged: false,
      loading: false,
      error: null,
    })
  })

  it('detects a newly paired eligible machine from the live fleet', async () => {
    const source = machine('source')
    const target = machine('target')
    const ineligible = machine('ineligible', false)
    const { result, rerender } = renderHook(
      ({ machines }: { machines: MachineWire[] }) =>
        useMachinePairing({
          trpc: trpcWithPairing(),
          machines,
          isNewMachineEligible: (candidate) => candidate.online,
        }),
      { initialProps: { machines: [source] } },
    )

    act(() => result.current.watchForNewMachine())
    rerender({ machines: [source, ineligible, target] })

    await waitFor(() => expect(result.current.newMachine?.id).toBe(target.id))
  })

  it('selects the first new machine accepted by the caller policy', () => {
    const baseline = new Set(['source'])
    expect(
      findNewMachine([machine('source'), machine('shared'), machine('managed')], baseline, (item) =>
        item.name.startsWith('managed'),
      )?.name,
    ).toBe('managed')
  })
})
