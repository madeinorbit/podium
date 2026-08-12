import { asMachineId } from '@podium/model'
import { act, renderHook } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import type { Store } from '@/app/store'
import {
  SERVER_TRANSFER_CONFIRMATION,
  isValidServerTransferUrl,
  type ServerTransferStatusController,
  type ServerTransferStatusSnapshot,
  transferDisplayState,
  useServerTransfer,
} from './server-transfer'

function transfer(
  overrides: Partial<NonNullable<ServerTransferStatusSnapshot['transfer']>> = {},
): NonNullable<ServerTransferStatusSnapshot['transfer']> {
  return {
    targetMachineId: asMachineId('target'),
    state: 'committed',
    phase: 'switching',
    sourceFenced: true,
    targetProof: false,
    sourceConnected: false,
    transferId: 'transfer-1',
    publicUrl: 'https://new-podium.example.com',
    ...overrides,
  } as NonNullable<ServerTransferStatusSnapshot['transfer']>
}

describe('server transfer controller', () => {
  it('requires proof and source reconnection before displaying Connected', () => {
    expect(transferDisplayState(transfer({ targetProof: true, sourceConnected: false }))).toBe(
      'switching',
    )
    expect(
      transferDisplayState(
        transfer({ phase: 'connected', targetProof: true, sourceConnected: true }),
      ),
    ).toBe('connected')
  })

  it('accepts only complete HTTP(S) target URLs', () => {
    expect(isValidServerTransferUrl('https://podium.example.com')).toBe(true)
    expect(isValidServerTransferUrl('http://127.0.0.1:3000')).toBe(true)
    expect(isValidServerTransferUrl('podium.example.com')).toBe(false)
    expect(isValidServerTransferUrl('ssh://podium.example.com')).toBe(false)
  })

  it('starts with the exact protocol confirmation and reconciles through durable status', async () => {
    const mutate = vi.fn().mockResolvedValue({ state: 'committed' })
    const refresh = vi.fn().mockResolvedValue(null)
    const status: ServerTransferStatusController = { snapshot: null, error: null, refresh }
    const trpc = {
      machines: { transferServer: { mutate } },
    } as unknown as Store['trpc']
    const { result } = renderHook(() =>
      useServerTransfer({ trpc, targetMachineId: asMachineId('target'), status }),
    )

    act(() => {
      result.current.setPublicUrl(' https://new-podium.example.com ')
      result.current.setConfirmation(SERVER_TRANSFER_CONFIRMATION)
    })
    expect(result.current.canStart).toBe(true)
    await act(() => result.current.start())

    expect(mutate).toHaveBeenCalledWith({
      targetMachineId: asMachineId('target'),
      publicUrl: 'https://new-podium.example.com',
      confirmation: SERVER_TRANSFER_CONFIRMATION,
    })
    expect(refresh).toHaveBeenCalledOnce()
    expect(result.current.awaitingStatus).toBe(true)
  })
})
