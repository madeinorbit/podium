import { expect, it } from 'vitest'
import { LifecyclePort } from './lifecycle-port'

it('refuses early use and a second installation, and exposes the installed workflow', () => {
  const port = new LifecyclePort<{ query(id: string): string }>('process readers')
  const read = port.read
  expect(() => read()).toThrow('process readers used before installation')
  const service = { query: (id: string) => `process:${id}` }
  port.install(service)
  expect(read()).toBe(service)
  expect(read().query('host')).toBe('process:host')
  expect(() => port.install({ query: () => 'replacement' })).toThrow(
    'process readers already installed',
  )
  expect(read()).toBe(service)
})
