import { expect, it, vi } from 'vitest'
import { companion } from './companion'

it('creates nothing until requested, and reuses the companion by entity identity', () => {
  const create = vi.fn((entity: object) => ({ entity }))
  const card = companion(create), a = {}, b = {}
  expect(create).not.toHaveBeenCalled()
  expect(card(a)).toBe(card(a))
  expect(card(b)).not.toBe(card(a))
  expect(create).toHaveBeenCalledTimes(2)
})

it('gives different views independent companions for the same entity', () => {
  const a = companion((entity: object) => ({ entity })), b = companion((entity: object) => ({ entity }))
  const entity = {}
  expect(a(entity)).not.toBe(b(entity))
})

it('also retains an undefined companion without repeating its factory', () => {
  const create = vi.fn(() => undefined), card = companion(create), entity = {}
  expect(card(entity)).toBeUndefined()
  expect(card(entity)).toBeUndefined()
  expect(create).toHaveBeenCalledTimes(1)
})
