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
  return Object.assign(
    owner,
    createSubscriptionStore({ closeFileTab: action } as unknown as Store, undefined, owner),
    { action },
  )
}

it('retires account-owned callbacks and state on principal changes while preserving same-account rebuilds', () => {
  const api = {} as PodiumClientApi
  const config: StoreServerConfig = {
    httpOrigin: 'http://offline.invalid',
    wsClientUrl: 'ws://offline.invalid',
  }
  const mounts: string[] = [],
    unmounts: string[] = []
  function Reader() {
    const owner = useStoreHandle()
    const principal = useCurrentPrincipal()!
    const close = useStoreSelector((s) => s.closeFileTab)
    const [draft, setDraft] = useState('')
    // These callbacks deliberately have mount lifetime, like UI gesture hooks.
    // They must see the current account even when their scalar inputs stay equal.
    const initialOwner = useCallback(() => owner, [])
    const closeAtMount = useCallback(() => close('file-1'), [])
    useEffect(() => {
      mounts.push(principal.userId)
      return () => {
        unmounts.push(principal.userId)
      }
    }, [])
    return (
      <>
        <output>
          {principal.userId}:{initialOwner() === owner ? 'current' : 'retired'}
        </output>
        <input
          aria-label="draft"
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
        />
        <button type="button" onClick={closeAtMount}>
          Close
        </button>
      </>
    )
  }
  const frame = (
    principal: ClientPrincipal | null,
    server = config,
    enabled = false,
    client = api,
  ) => (
    <StoreProvider
      principal={principal}
      config={server}
      api={client}
      networkEnabled={enabled}
      onFatalError={() => {}}
      createReplicaFn={() => {
        throw new Error('fixture owns runtime')
      }}
    >
      <Reader />
    </StoreProvider>
  )
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

  // Reconnection or endpoint changes may rebuild a runtime for the SAME account.
  // They must preserve local UI state rather than remounting the whole app.
  fireEvent.change(view.getByLabelText('draft'), { target: { value: 'new draft' } })
  for (const tree of [
    frame(alice, { ...config }),
    frame(alice, config, true),
    frame(alice, config, true, {} as PodiumClientApi),
  ]) {
    const replacement = runtime()
    fixture.handle = replacement
    view.rerender(tree)
    expect(previous.destroy).toHaveBeenCalledOnce()
    expect(view.getByLabelText<HTMLInputElement>('draft').value).toBe('new draft')
    expect(mounts).toEqual(['alice', 'bob', 'alice'])
    previous = replacement
  }

  // A server-issued rescope changes the account's storage identity.
  fixture.handle = runtime()
  view.rerender(frame(asClientPrincipal(alice.userId, 'replacement-boundary')))
  expect(previous.destroy).toHaveBeenCalledOnce()
  expect(view.getByLabelText<HTMLInputElement>('draft').value).toBe('')
  view.rerender(frame(null))
  expect(view.container.textContent).toBe('')
  expect(unmounts).toEqual(['alice', 'bob', 'alice', 'alice'])
})
