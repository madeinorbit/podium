import { describe, expect, it, vi } from 'vitest'
import {
  type StorageEventLike,
  type StorageEventSource,
  savedProfilesStillHold,
  watchAccountSwitch,
} from './account-switch'

const ALICE = { syncBoundaryId: 'boundary-1', memberId: 'mem_alice' }
const KEY = 'podium.accounts.web.scope.profiles.v1'

const profile = (memberId: string, extra: Record<string, unknown> = {}) => ({
  id: 'single-server',
  name: 'host',
  httpOrigin: 'http://host',
  mode: 'protected',
  transport: 'loopback',
  syncBoundaryId: 'boundary-1',
  memberId,
  userId: memberId,
  ...extra,
})
const state = (...profiles: object[]) =>
  JSON.stringify({ activeProfileId: 'single-server', profiles })

function source() {
  const listeners = new Set<(event: StorageEventLike) => void>()
  const api: StorageEventSource = {
    addEventListener: (_type, listener) => listeners.add(listener),
    removeEventListener: (_type, listener) => listeners.delete(listener),
  }
  return {
    api,
    emit: (event: StorageEventLike) => {
      for (const listener of listeners) listener(event)
    },
    size: () => listeners.size,
  }
}

describe('savedProfilesStillHold', () => {
  it('holds while the active profile is this member, signed in', () => {
    expect(savedProfilesStillHold(state(profile('mem_alice')), ALICE)).toBe(true)
  })
  it('does not hold once another member is the active account', () => {
    expect(savedProfilesStillHold(state(profile('mem_bob')), ALICE)).toBe(false)
  })
  it('does not hold once this member signed out or was removed', () => {
    expect(savedProfilesStillHold(state(profile('mem_alice', { signedOut: true })), ALICE)).toBe(
      false,
    )
    expect(savedProfilesStillHold(state(), ALICE)).toBe(false)
    expect(savedProfilesStillHold(null, ALICE)).toBe(false)
    expect(savedProfilesStillHold('{not json', ALICE)).toBe(false)
  })
  it('does not hold for the same member on a different sync boundary', () => {
    expect(
      savedProfilesStillHold(state(profile('mem_alice', { syncBoundaryId: 'other' })), ALICE),
    ).toBe(false)
  })
})

describe('watchAccountSwitch', () => {
  it('fires once when another tab signs Alice out, then Bob in', () => {
    const events = source()
    const onSwitched = vi.fn()
    watchAccountSwitch({ source: events.api, profilesKey: KEY, identity: ALICE, onSwitched })
    events.emit({ key: 'unrelated', newValue: null })
    events.emit({ key: KEY, newValue: state(profile('mem_alice')) })
    expect(onSwitched).not.toHaveBeenCalled()
    events.emit({ key: KEY, newValue: state() })
    events.emit({ key: KEY, newValue: state(profile('mem_bob')) })
    expect(onSwitched).toHaveBeenCalledTimes(1)
  })
  it('fires when another tab clears storage, and unsubscribes', () => {
    const events = source()
    const onSwitched = vi.fn()
    const stop = watchAccountSwitch({
      source: events.api,
      profilesKey: KEY,
      identity: ALICE,
      onSwitched,
    })
    events.emit({ key: null, newValue: null })
    expect(onSwitched).toHaveBeenCalledTimes(1)
    stop()
    expect(events.size()).toBe(0)
  })
})
