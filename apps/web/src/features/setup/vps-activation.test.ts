import { asMachineId } from '@podium/model'
import { describe, expect, it, vi } from 'vitest'
import type { Trpc } from '@/app/trpc'
import {
  clearVpsActivation,
  persistVpsActivation,
  readVpsActivation,
  startAfterVpsPersistence,
} from './use-vps-activation'
import {
  isDestinationOrigin,
  parseVpsActivation,
  serializeVpsActivation,
  startVpsPairingState,
  vpsDestinationUrl,
  vpsIntroState,
  vpsPairingState,
  vpsTransferState,
} from './vps-activation'

interface Deferred<T> {
  promise: Promise<T>
  resolve: (value: T) => void
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

describe('durable VPS activation state', () => {
  it('starts a new VPS setup at shared machine pairing', () => {
    expect(startVpsPairingState('welcome', [asMachineId('source')])).toMatchObject({
      route: 'vps-pairing',
      returnRoute: 'welcome',
      baselineMachineIds: ['source'],
      moveServer: true,
    })
  })

  it('round-trips the versioned route, preserved local return, baseline, and target', () => {
    const pairing = vpsPairingState(vpsIntroState('local-project'), [
      asMachineId('source'),
      asMachineId('existing-daemon'),
    ])
    const transfer = vpsTransferState(pairing, {
      machineId: asMachineId('new-vps'),
      name: 'Always-on VPS',
      publicUrl: 'https://vps.example.com',
    })

    expect(parseVpsActivation(serializeVpsActivation(transfer))).toEqual(transfer)
    expect(parseVpsActivation('{"version":2}')).toBeNull()
  })

  it('accepts a selected transfer target before its public URL is entered', () => {
    const transfer = vpsTransferState(vpsPairingState(vpsIntroState('welcome'), []), {
      machineId: asMachineId('vps'),
      name: 'VPS',
    })

    expect(parseVpsActivation(serializeVpsActivation(transfer))).toEqual(transfer)
  })

  it('persists the daemon-only choice across pairing reloads', () => {
    const pairing = vpsPairingState(vpsIntroState('welcome'), [asMachineId('source')], false)

    expect(parseVpsActivation(serializeVpsActivation(pairing))).toMatchObject({
      route: 'vps-pairing',
      moveServer: false,
    })
  })

  it('awaits a server snapshot containing the exact value', async () => {
    const state = vpsPairingState(vpsIntroState('welcome'), [asMachineId('source')])
    const mutate = vi.fn().mockResolvedValue({
      'onboarding.vps': serializeVpsActivation(state),
    })
    const trpc = { layout: { set: { mutate } } } as unknown as Pick<Trpc, 'layout'>

    await expect(persistVpsActivation(trpc, state)).resolves.toEqual(state)
    expect(mutate).toHaveBeenCalledWith({
      values: { 'onboarding.vps': serializeVpsActivation(state) },
    })
  })

  it('restores a server checkpoint even when the browser replica starts cold', async () => {
    const state = vpsTransferState(vpsPairingState(vpsIntroState('local-project'), []), {
      machineId: asMachineId('vps'),
      name: 'VPS',
      publicUrl: 'https://vps.example.com',
    })
    const query = vi.fn().mockResolvedValue({
      'onboarding.vps': serializeVpsActivation(state),
    })
    const trpc = { layout: { get: { query } } } as unknown as Pick<Trpc, 'layout'>

    await expect(readVpsActivation(trpc)).resolves.toEqual(state)
    expect(query).toHaveBeenCalledOnce()
  })

  it('refuses to cross the transfer boundary before server persistence resolves', async () => {
    const confirmed = deferred<unknown>()
    const start = vi.fn().mockResolvedValue(undefined)
    const pending = startAfterVpsPersistence(() => confirmed.promise, start)

    await Promise.resolve()
    expect(start).not.toHaveBeenCalled()

    confirmed.resolve(undefined)
    await pending
    expect(start).toHaveBeenCalledOnce()
  })

  it('never starts transfer when the authoritative checkpoint is rejected', async () => {
    const start = vi.fn().mockResolvedValue(undefined)

    await expect(
      startAfterVpsPersistence(() => Promise.reject(new Error('checkpoint mismatch')), start),
    ).rejects.toThrow('checkpoint mismatch')
    expect(start).not.toHaveBeenCalled()
  })

  it('requires authoritative removal when activation completes', async () => {
    const mutate = vi.fn().mockResolvedValue({})
    const trpc = { layout: { clear: { mutate } } } as unknown as Pick<Trpc, 'layout'>

    await expect(clearVpsActivation(trpc)).resolves.toBeUndefined()
    expect(mutate).toHaveBeenCalledWith({ keys: ['onboarding.vps'] })
  })

  it('does not report completion while the server still returns the checkpoint', async () => {
    const state = vpsIntroState('welcome')
    const mutate = vi.fn().mockResolvedValue({
      'onboarding.vps': serializeVpsActivation(state),
    })
    const trpc = { layout: { clear: { mutate } } } as unknown as Pick<Trpc, 'layout'>

    await expect(clearVpsActivation(trpc)).rejects.toThrow(/did not confirm/i)
  })

  it('builds a resumable same-tab destination and compares origins', () => {
    const destination = vpsDestinationUrl('https://vps.example.com/base')
    expect(destination).toBe('https://vps.example.com/workspace?activation=vps-transfer')
    expect(isDestinationOrigin(destination as string, 'https://vps.example.com')).toBe(true)
    expect(isDestinationOrigin(destination as string, 'https://laptop.example.com')).toBe(false)
    expect(vpsDestinationUrl('https://user:secret@vps.example.com')).toBeNull()
  })
})
