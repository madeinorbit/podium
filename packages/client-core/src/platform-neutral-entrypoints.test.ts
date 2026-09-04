import { afterEach, describe, expect, it, vi } from 'vitest'
import { existsSync, readFileSync } from 'node:fs'
import { extname, join, resolve } from 'node:path'

const descriptors = new Map<PropertyKey, PropertyDescriptor | undefined>()

function rejectAmbientRead(name: 'window' | 'document' | 'navigator'): void {
  descriptors.set(name, Object.getOwnPropertyDescriptor(globalThis, name))
  Object.defineProperty(globalThis, name, {
    configurable: true,
    get() {
      throw new Error(`${name} was read while evaluating a platform-neutral entrypoint`)
    },
  })
}

afterEach(() => {
  for (const [name, descriptor] of descriptors) {
    if (descriptor) Object.defineProperty(globalThis, name, descriptor)
    else Reflect.deleteProperty(globalThis, name)
  }
  descriptors.clear()
  vi.resetModules()
})

describe('platform-neutral client-core entrypoints', () => {
  it.each([
    'transcript',
    'conversation',
  ] as const)('%s evaluates without DOM or browser globals', async (entrypoint) => {
    rejectAmbientRead('window')
    rejectAmbientRead('document')
    rejectAmbientRead('navigator')

    const module =
      entrypoint === 'transcript'
        ? await import('@podium/client-core/transcript')
        : await import('@podium/client-core/conversation')

    expect(Object.keys(module).length).toBeGreaterThan(0)
  })

  it.each([
    'transcript',
    'conversation',
  ] as const)('%s import closure excludes UI and CLI runtimes', (entrypoint) => {
    const visited = new Set<string>()
    const forbidden: string[] = []
    const visit = (file: string): void => {
      if (visited.has(file)) return
      visited.add(file)
      const source = readFileSync(file, 'utf8')
      const specifiers = [...source.matchAll(/(?:from\s+|import\s*\()['"]([^'"]+)['"]/g)].map(
        (match) => match[1] as string,
      )
      for (const specifier of specifiers) {
        if (
          specifier === 'react' ||
          specifier.startsWith('react/') ||
          specifier === 'react-native' ||
          specifier.startsWith('react-native/') ||
          specifier.startsWith('expo') ||
          specifier.includes('/cli')
        ) {
          forbidden.push(`${file}: ${specifier}`)
        }
        if (!specifier.startsWith('.')) continue
        const candidate = resolve(file, '..', specifier)
        const resolved = extname(candidate)
          ? candidate
          : existsSync(`${candidate}.ts`)
            ? `${candidate}.ts`
            : join(candidate, 'index.ts')
        if (existsSync(resolved)) visit(resolved)
      }
    }

    visit(join(import.meta.dirname, entrypoint, 'index.ts'))
    expect(forbidden).toEqual([])
  })
})
