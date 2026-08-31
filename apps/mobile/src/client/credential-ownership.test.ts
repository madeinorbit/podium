import { describe, expect, it, vi } from 'vitest'
import {
  CredentialWriteQueue,
  StaleCredentialOwnerError,
  replaceCredentialForOwner,
} from './credential-ownership'

describe('profile-owned credential completion', () => {
  it('refuses a completion captured before the active profile changed', async () => {
    const write = vi.fn(async () => {})
    const remove = vi.fn(async () => {})

    await expect(
      replaceCredentialForOwner({
        token: 'profile-a-token',
        isCurrent: () => false,
        read: async () => null,
        write,
        remove,
      }),
    ).rejects.toBeInstanceOf(StaleCredentialOwnerError)
    expect(write).not.toHaveBeenCalled()
    expect(remove).not.toHaveBeenCalled()
  })

  it('restores the prior credential when ownership changes during the write', async () => {
    let current = true
    const stored: string[] = []

    await expect(
      replaceCredentialForOwner({
        token: 'late-token',
        isCurrent: () => current,
        read: async () => 'prior-token',
        write: async (token) => {
          stored.push(token)
          if (token === 'late-token') current = false
        },
        remove: async () => {},
      }),
    ).rejects.toBeInstanceOf(StaleCredentialOwnerError)
    expect(stored).toEqual(['late-token', 'prior-token'])
  })

  it('keeps a newer serialized write after a stale write rolls back', async () => {
    const queue = new CredentialWriteQueue()
    let current = true
    let stored = 'prior-token'
    const first = queue.run(() =>
      replaceCredentialForOwner({
        token: 'late-token',
        isCurrent: () => current,
        read: async () => stored,
        write: async (token) => {
          stored = token
          if (token === 'late-token') current = false
        },
        remove: async () => {
          stored = ''
        },
      }),
    )
    const second = queue.run(async () => {
      stored = 'new-profile-token'
    })

    await expect(first).rejects.toBeInstanceOf(StaleCredentialOwnerError)
    await second
    expect(stored).toBe('new-profile-token')
  })
})
