import { describe, expect, it } from 'vitest'
import { asUserId } from '../ids/brands'
import { firstAdminMemberId } from './first-admin'

const first = asUserId('mem_0ujtsYcgvSTl8PAuAdqWYSMnLOv')
const second = asUserId('mem_0ujzPyRiIAffKhBux4PvQdDqMHY')

describe('store scoped first administrator', () => {
  it('resolves independently and observes changed membership', async () => {
    let member = first
    const a = { users: { earliestAdmin: async () => ({ id: member }) } }
    const b = { users: { earliestAdmin: async () => ({ id: second }) } }
    expect(await firstAdminMemberId(a)).toBe(first)
    expect(await firstAdminMemberId(b)).toBe(second)
    expect(await firstAdminMemberId(a)).toBe(first)
    member = second
    expect(await firstAdminMemberId(a)).toBe(second)
  })

  it('refuses a store without an active administrator', async () => {
    const populated = { users: { earliestAdmin: async () => ({ id: first }) } }
    const empty = { users: { earliestAdmin: async () => undefined } }
    await firstAdminMemberId(populated)
    await expect(firstAdminMemberId(empty)).rejects.toThrow(/no active administrator/)
  })
})
