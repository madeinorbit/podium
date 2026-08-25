import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { readInstallTopology } from './install-topology'

const cleanup: string[] = []

afterEach(() => {
  for (const path of cleanup.splice(0)) rmSync(path, { recursive: true, force: true })
})

function scratch(label: string): string {
  const path = mkdtempSync(join(tmpdir(), `podium-topology-${label}-`))
  cleanup.push(path)
  return path
}

function realDirectory(path: string): void {
  mkdirSync(path, { recursive: true })
  writeFileSync(join(path, 'package.json'), '{"name":"placeholder"}\n')
}

function link(path: string, target: string): void {
  mkdirSync(dirname(path), { recursive: true })
  symlinkSync(target, path)
}

/** A checkout with one workspace, installed the way `layout` names. */
function checkout(
  layout: 'hoisted' | 'isolated',
  options: { store?: string; nodePty?: 'absent' | 'linked' | 'dangling' } = {},
): string {
  const root = scratch(layout)
  writeFileSync(join(root, 'package.json'), '{"private":true,"workspaces":["packages/*"]}\n')
  writeFileSync(join(root, 'bunfig.toml'), '[install]\nlinker = "hoisted"\n')
  realDirectory(join(root, 'packages/pty'))
  writeFileSync(join(root, 'packages/pty/package.json'), '{"name":"@podium/pty"}\n')
  const modules = join(root, 'node_modules')
  mkdirSync(modules, { recursive: true })
  link(join(modules, '@podium/pty'), '../../packages/pty')
  link(join(modules, '.bin/tsgo'), '../typescript/bin/tsgo')
  realDirectory(join(modules, 'typescript/bin'))
  writeFileSync(join(modules, 'typescript/bin/tsgo'), '#!/bin/sh\n')

  if (layout === 'hoisted') {
    realDirectory(join(modules, 'left-pad'))
    if (options.nodePty === 'linked') realDirectory(join(modules, 'node-pty'))
    if (options.nodePty === 'dangling') link(join(modules, 'node-pty'), '../evaporated/node-pty')
    return root
  }

  const store = options.store ?? scratch('store')
  realDirectory(join(store, 'left-pad@1.3.0/node_modules/left-pad'))
  link(join(modules, '.bun/left-pad@1.3.0'), join(store, 'left-pad@1.3.0'))
  link(join(modules, 'left-pad'), '.bun/left-pad@1.3.0/node_modules/left-pad')
  if (options.nodePty === 'linked') {
    realDirectory(join(store, 'node-pty@1.0.0/node_modules/node-pty'))
    link(join(modules, '.bun/node-pty@1.0.0'), join(store, 'node-pty@1.0.0'))
    link(join(modules, 'node-pty'), '.bun/node-pty@1.0.0/node_modules/node-pty')
  }
  if (options.nodePty === 'dangling') {
    link(join(modules, 'node-pty'), '.bun/node-pty@1.0.0/node_modules/node-pty')
  }
  return root
}

describe('install topology as cache identity', () => {
  it('separates a hoisted install from an isolated one that shares its bunfig.toml', () => {
    // Neither checkout's tracked bunfig.toml mentions the isolated linker: the canary
    // passes it as an external --config. Before POD-2774 that made them one cache identity.
    const hoisted = readInstallTopology(checkout('hoisted'), scratch('home'))
    const isolated = readInstallTopology(checkout('isolated'), scratch('home'))

    expect(isolated.config).toEqual(hoisted.config)
    expect(isolated.layout).not.toEqual(hoisted.layout)
    expect(hoisted.layout).toContain('node_modules\tleft-pad\td\t-')
    expect(isolated.layout).toContain(
      'node_modules\tleft-pad\tl\t.bun/left-pad@1.3.0/node_modules/left-pad',
    )
  })

  it('two independently installed checkouts agree, wherever they sit', () => {
    // This is what makes one cache reusable across sibling worktrees: nothing in a
    // record may carry the checkout's path, or its store's.
    const home = scratch('home')
    const first = readInstallTopology(checkout('isolated'), home)
    const second = readInstallTopology(checkout('isolated'), home)

    expect(second.layout).toEqual(first.layout)
    expect(second.errors).toEqual([])
    expect(first.layout.some((record) => record.includes(tmpdir()))).toBe(false)
  })

  it('records an out-of-checkout target by class, not by which store it is', () => {
    const home = scratch('home')
    const shared = readInstallTopology(checkout('isolated', { store: scratch('store-a') }), home)
    const separate = readInstallTopology(checkout('isolated', { store: scratch('store-b') }), home)

    expect(separate.layout).toEqual(shared.layout)
    expect(shared.layout).toContain('node_modules/.bun\tleft-pad@1.3.0\tl\texternal')
  })

  it('walks the node_modules each workspace owns', () => {
    const root = checkout('hoisted')
    link(join(root, 'packages/pty/node_modules/node-pty'), '../../../evaporated/node-pty')

    const topology = readInstallTopology(root, scratch('home'))
    expect(topology.errors).toEqual([
      'install topology: packages/pty/node_modules/node-pty is a dangling symlink ' +
        '(-> ../../../evaporated/node-pty)',
    ])
  })
})

describe('install topology admission', () => {
  it.each([
    'hoisted',
    'isolated',
  ] as const)('refuses a dangling third-party link in a %s install', (layout) => {
    const topology = readInstallTopology(checkout(layout, { nodePty: 'dangling' }), scratch('home'))
    expect(topology.errors).toHaveLength(1)
    expect(topology.errors[0]).toContain('node_modules/node-pty is a dangling symlink')
  })

  it.each([
    'hoisted',
    'isolated',
  ] as const)('accepts an optional package that is simply absent from a %s install', (layout) => {
    // node-pty is optional and routinely missing. Absent is not broken; only a link
    // that points at nothing is, and conflating the two would refuse healthy installs.
    expect(
      readInstallTopology(checkout(layout, { nodePty: 'absent' }), scratch('home')).errors,
    ).toEqual([])
    expect(
      readInstallTopology(checkout(layout, { nodePty: 'linked' }), scratch('home')).errors,
    ).toEqual([])
  })

  it('refuses a dangling executable in .bin', () => {
    const root = checkout('hoisted')
    rmSync(join(root, 'node_modules/typescript'), { recursive: true, force: true })

    const topology = readInstallTopology(root, scratch('home'))
    expect(topology.errors).toEqual([
      'install topology: node_modules/.bin/tsgo is a dangling symlink (-> ../typescript/bin/tsgo)',
    ])
  })

  it('refuses a dangling link inside an isolated store link farm', () => {
    const store = scratch('store')
    const root = checkout('isolated', { store })
    link(join(store, 'left-pad@1.3.0/node_modules/its-dependency'), '../../evaporated')

    const topology = readInstallTopology(root, scratch('home'))
    expect(topology.errors).toEqual([
      'install topology: node_modules/.bun/left-pad@1.3.0/node_modules/its-dependency ' +
        'is a dangling symlink (-> ../../evaporated)',
    ])
  })

  it('opens scoped store entries, which nest one directory deeper', () => {
    const store = scratch('store')
    const root = checkout('isolated', { store })
    realDirectory(join(store, '@scope/pkg@2.0.0/node_modules/@scope/pkg'))
    link(join(root, 'node_modules/.bun/@scope/pkg@2.0.0'), join(store, '@scope/pkg@2.0.0'))
    link(join(store, '@scope/pkg@2.0.0/node_modules/its-dependency'), '../../../evaporated')

    const topology = readInstallTopology(root, scratch('home'))
    expect(topology.errors).toEqual([
      'install topology: node_modules/.bun/@scope/pkg@2.0.0/node_modules/its-dependency ' +
        'is a dangling symlink (-> ../../../evaporated)',
    ])
  })

  it('refuses a dangling link nested under a hoisted package', () => {
    // A hoisted install writes <pkg>/node_modules whenever two versions collide. That
    // tree is reached by being pointed at, the same way the isolated store's farms are.
    const root = checkout('hoisted')
    link(join(root, 'node_modules/left-pad/node_modules/its-dependency'), '../../evaporated')

    expect(readInstallTopology(root, scratch('home')).errors).toEqual([
      'install topology: node_modules/left-pad/node_modules/its-dependency ' +
        'is a dangling symlink (-> ../../evaporated)',
    ])
  })

  it('walks a directory reachable by two names only once', () => {
    // node_modules/left-pad and .bun/left-pad@1.3.0/node_modules/left-pad are the same
    // directory. Recording it twice would inflate the fingerprint and, on a link cycle,
    // never finish.
    const root = checkout('isolated')
    link(join(root, 'node_modules/left-pad/node_modules/its-dependency'), '../../evaporated')

    const topology = readInstallTopology(root, scratch('home'))
    expect(topology.errors).toHaveLength(1)
    expect(new Set(topology.layout).size).toBe(topology.layout.length)
  })

  it('refuses a checkout with no install at all', () => {
    const root = checkout('hoisted')
    rmSync(join(root, 'node_modules'), { recursive: true, force: true })

    expect(readInstallTopology(root, scratch('home')).errors).toEqual([
      'install topology: node_modules is missing; there is no install to trust',
    ])
  })
})

describe('effective install configuration', () => {
  it('hashes the checkout bunfig and the global one Bun would also read', () => {
    const root = checkout('hoisted')
    const home = scratch('home')
    const before = readInstallTopology(root, home)
    expect(before.config[1]).toBe('global\tabsent')

    writeFileSync(join(home, '.bunfig.toml'), '[install]\nlinker = "isolated"\n')
    const after = readInstallTopology(root, home)
    expect(after.config[0]).toBe(before.config[0])
    expect(after.config[1]).not.toBe(before.config[1])
  })

  it('moves when the checkout bunfig changes', () => {
    const root = checkout('hoisted')
    const home = scratch('home')
    const before = readInstallTopology(root, home)

    writeFileSync(join(root, 'bunfig.toml'), '[install]\nlinker = "isolated"\n')
    expect(readInstallTopology(root, home).config[0]).not.toBe(before.config[0])
  })
})
