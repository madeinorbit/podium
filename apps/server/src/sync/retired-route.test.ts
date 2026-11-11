import { expect, it } from 'vitest'
import { appRouter } from '../router'

it('exposes sync writes without the retired tRPC catch-up route', () => {
  const procedures = appRouter._def.procedures
  expect(procedures).toHaveProperty('sync.submit')
  expect(Object.keys(procedures)).not.toContain('sync.changesSince')
})
