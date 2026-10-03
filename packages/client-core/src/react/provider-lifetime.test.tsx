// @vitest-environment happy-dom
import { asUserId } from '@podium/model'
import { cleanup, fireEvent, render } from '@testing-library/react'
import { useCallback, useEffect, useState } from 'react'
import { afterEach, expect, it, vi } from 'vitest'
import type { PodiumClientApi } from '../api'
import type { Store, StoreServerConfig } from '../engine/types'
import { asClientPrincipal, type ClientPrincipal } from '../principal'
import { createSubscriptionStore } from '../store'
import { StoreProvider, useCurrentPrincipal, useStoreHandle, useStoreSelector } from './provider'

const fixture = vi.hoisted(() => ({ handle: null as unknown }))
vi.mock('../engine/runtime', () => ({ createClientRuntime: () => fixture.handle }))
afterEach(cleanup)

function runtime() {
  const action = vi.fn()
  const owner = { start: vi.fn(), dispose: vi.fn(), destroy: vi.fn() }
  return Object.assign(owner, createSubscriptionStore(
    { closeFileTab: action } as unknown as Store,
    undefined,
    owner,
  ), { action })
}

it('retires account-owned callbacks and local state with each reconstructed runtime', () => {
  const api = {} as PodiumClientApi
  const config: StoreServerConfig = { httpOrigin: 'http://offline.invalid', wsClientUrl: 'ws://offline.invalid' }
  const mounts: string[] = [], unmounts: string[] = []
  function Reader() {
    const owner = useStoreHandle()
    const principal = useCurrentPrincipal()!
    const close = useStoreSelector(s => s.closeFileTab)
    const [draft, setDraft] = useState('')
    // These callbacks deliberately have mount lifetime, like UI gesture hooks.
    // They must see the current account even when their scalar inputs stay equal.
    const initialOwner = useCallback(() => owner, [])
    const closeAtMount = useCallback(() => close('file-1'), [])
    useEffect(() => {
      mounts.push(principal.userId)
      return () => { unmounts.push(principal.userId) }
    }, [])
    return <>
      <output>{principal.userId}:{initialOwner() === owner ? 'current' : 'retired'}</output>
      <input aria-label="draft" value={draft} onChange={event => setDraft(event.target.value)} />
      <button type="button" onClick={closeAtMount}>Close</button>
    </>
  }
  const frame = (principal: ClientPrincipal | null, server = config) => <StoreProvider
    principal={principal} config={server} api={api} networkEnabled={false}
    onFatalError={() => {}} createReplicaFn={() => { throw new Error('fixture owns runtime') }}
  ><Reader /></StoreProvider>
  const alice = asClientPrincipal(asUserId('alice'))
  let previous = runtime()
  fixture.handle = previous
  const view = render(frame(alice))
  fireEvent.change(view.getByLabelText('draft'), { target: { value: 'Alice draft' } })
  view.rerender(frame({ ...alice }))
  expect(view.getByLabelText<HTMLInputElement>('draft').value).toBe('Alice draft')
  expect(mounts).toEqual(['alice'])
  expect(previous.destroy).not.toHaveBeenCalled()
  expect(view.container.querySelector('output')?.textContent).toBe('alice:current')

  for (const name of ['bob', 'alice']) {
    const next = runtime()
    fixture.handle = next
    view.rerender(frame(asClientPrincipal(asUserId(name))))
    expect(previous.destroy).toHaveBeenCalledOnce()
    expect(view.getByLabelText<HTMLInputElement>('draft').value).toBe('')
    expect(view.container.querySelector('output')?.textContent).toBe(`${name}:current`)
    fireEvent.click(view.getByText('Close'))
    expect(next.action).toHaveBeenCalledWith('file-1')
    previous = next
  }
  expect(mounts).toEqual(['alice', 'bob', 'alice'])
  expect(unmounts).toEqual(['alice', 'bob'])

  // A config rebuild belongs to a new runtime even for the same user.
  fireEvent.change(view.getByLabelText('draft'), { target: { value: 'new draft' } })
  fixture.handle = runtime()
  view.rerender(frame(alice, { ...config }))
  expect(previous.destroy).toHaveBeenCalledOnce()
  expect(view.getByLabelText<HTMLInputElement>('draft').value).toBe('')
  view.rerender(frame(null))
  expect(view.container.textContent).toBe('')
  expect(unmounts).toEqual(['alice', 'bob', 'alice', 'alice'])
})
