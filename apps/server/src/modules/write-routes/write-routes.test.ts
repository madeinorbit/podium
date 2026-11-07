/**
 * EVERY WRITE ROUTE IS GENERATED FROM A REGISTRATION (ADR 12 D9, POD-6593).
 *
 * Against the router the server serves and the registries it composes: every
 * mutation carries `meta.registration` and names a command that exists, in the
 * sync registry, the plain registry or the direct-write census; a declaration
 * not exposed on tRPC gets no route; and a command a client could queue can
 * only be a sync registration. That modules cannot build a mutation at all is
 * a type, held by `write-routes.typecheck.ts`.
 */

import * as commands from '@podium/commands'
import {
  type AnyCommandContract,
  type CommandDef,
  defineCommands,
  layoutSetContract,
} from '@podium/commands'
import type { AnyProcedure } from '@trpc/server'
import { afterEach, describe, expect, it } from 'vitest'
import { z } from 'zod'
import { appRouter } from '../../router'
import type { RouteMeta } from '../../trpc'
import { plainCommands } from '../plain-command/commands'
import { PlainCommandRegistry } from '../plain-command/registry'
import { disposeOracles, makeOracle } from '../sessions/oracle-support'
import { DIRECT_WRITE_OWNERS, DIRECT_WRITES, directRoute, isDirectWrite } from './direct'
import { plainRoute } from './plain'
import { syncRoute } from './sync'

afterEach(() => disposeOracles())

interface Served {
  readonly path: string
  readonly type: string
  readonly meta: RouteMeta | undefined
}

/** Every procedure `appRouter` serves, by its dotted path. */
function served(): Served[] {
  const procedures = appRouter._def.procedures as unknown as Record<string, AnyProcedure>
  return Object.entries(procedures).map(([path, procedure]) => ({
    path,
    type: procedure._def.type,
    meta: procedure._def.meta as RouteMeta | undefined,
  }))
}

const mutations = () => served().filter((p) => p.type === 'mutation')

describe('the served write routes', () => {
  it('every mutation carries a registration, and it exists', async () => {
    const o = await makeOracle()
    const sync = o.reg.modules.syncWrite.registry
    const plain = plainCommands()
    const missing: string[] = []
    for (const { path, meta } of mutations()) {
      const registration = meta?.registration
      if (registration === undefined || meta?.path === undefined) {
        missing.push(`${path}: no registration`)
        continue
      }
      const exists =
        meta.path === 'sync'
          ? registration === '*' || sync.lookup(registration) !== undefined
          : meta.path === 'plain'
            ? plain.lookup(registration) !== undefined
            : isDirectWrite(registration)
      if (!exists) missing.push(`${path}: ${meta.path} registration ${registration} does not exist`)
    }
    expect(missing).toEqual([])
    expect(mutations().length).toBeGreaterThan(100)
  })

  it('only `sync.submit` takes whichever registration its envelope names', () => {
    expect(
      mutations()
        .filter((p) => p.meta?.registration === '*')
        .map((p) => p.path),
    ).toEqual(['sync.submit'])
  })

  it('a query carries no registration', () => {
    const tagged = served().filter((p) => p.type !== 'mutation' && p.meta?.registration)
    expect(tagged.map((p) => p.path)).toEqual([])
  })

  it('every plain registration exposed on tRPC is served', () => {
    const routed = new Set(
      mutations()
        .filter((p) => p.meta?.path === 'plain')
        .map((p) => p.meta?.registration),
    )
    const plain = plainCommands()
    const unserved = plain
      .names()
      .filter((name) => plain.lookup(name)?.door.exposedOn('trpc') === true && !routed.has(name))
    expect(unserved).toEqual([])
  })

  it('the direct-write census names exactly the direct routes served', () => {
    const routed = mutations()
      .filter((p) => p.meta?.path === 'direct')
      .map((p) => p.meta?.registration)
      .sort()
    expect(routed).toEqual(Object.keys(DIRECT_WRITES).sort())
  })

  it('every direct write is owned by an issue that moves it onto a registration', () => {
    const owners: readonly string[] = DIRECT_WRITE_OWNERS
    const strays = Object.entries(DIRECT_WRITES)
      .filter(([, spec]) => !owners.includes(spec.owner))
      .map(([name]) => name)
    expect(strays).toEqual([])
  })
})

describe('exposure decides the adapter', () => {
  const notOnTrpc = { ...layoutSetContract, exposure: ['outbox'] } as AnyCommandContract

  it('a sync declaration not exposed on tRPC has no tRPC route', () => {
    expect(() => syncRoute({ command: notOnTrpc })).toThrow(/is not exposed on trpc/)
  })

  it('a plain route names a plain registration', () => {
    expect(() => plainRoute('layout.set')).toThrow(/is not in the plain registry/)
  })

  it('a direct route names a census entry', () => {
    expect(() =>
      directRoute('layout.set', { input: z.object({}), run: async () => undefined }),
    ).toThrow(/direct-write census/)
  })
})

describe('a command a client could queue is a sync registration', () => {
  it('the plain registry refuses a queued contract', () => {
    expect(() =>
      new PlainCommandRegistry().register({ contract: layoutSetContract, handle: () => undefined }),
    ).toThrow(/online only|never queued/)
  })

  it('the plain registry refuses an offline-eligible def', () => {
    const queued = defineCommands('fixture', {
      write: {
        input: z.object({}),
        action: 'write',
        exposure: ['trpc'],
        offline: 'eligible',
      },
    } satisfies Record<'write', CommandDef>)
    expect(() =>
      new PlainCommandRegistry().register({
        name: 'fixture.write',
        def: queued.defs.write,
        handle: () => undefined,
      }),
    ).toThrow(/offline-eligible/)
  })

  it('every command a client could queue is a sync registration (or a census entry)', async () => {
    const o = await makeOracle()
    const sync = o.reg.modules.syncWrite.registry
    const queued = everyDeclaration()
      .filter((declaration) => declaration.queueable)
      .map((declaration) => declaration.name)
    expect(queued.length).toBeGreaterThan(10)
    // Or, until its owner moves it onto the entry point, a direct write.
    expect(
      queued.filter((name) => sync.lookup(name) === undefined && !isDirectWrite(name)),
    ).toEqual([])
  })
})

interface Declaration {
  readonly name: string
  /** A client may queue it: an offline-eligible delivery, or the outbox among
   *  its transports. */
  readonly queueable: boolean
}

/**
 * Every command `@podium/commands` exports, as a contract (alone, in a table, or
 * as a `{ contract, handler }` entry) or as a `defineCommands` def, by name.
 */
function everyDeclaration(): Declaration[] {
  const found = new Map<string, Declaration>()
  const visit = (value: unknown): void => {
    if (isContract(value)) {
      found.set(value.name, {
        name: value.name,
        queueable: value.delivery.class === 'offline-eligible' || value.exposure.includes('outbox'),
      })
    }
  }
  for (const value of Object.values(commands)) {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) continue
    visit(value)
    if (isDefRegistry(value)) {
      for (const [key, def] of Object.entries(value.defs)) {
        found.set(`${value.namespace}.${key}`, {
          name: `${value.namespace}.${key}`,
          // A def's transports have no outbox: its offline class says it.
          queueable: def.offline === 'eligible',
        })
      }
      continue
    }
    for (const inner of Object.values(value as Record<string, unknown>)) {
      visit(inner)
      if (inner !== null && typeof inner === 'object' && 'contract' in inner) {
        visit((inner as { contract: unknown }).contract)
      }
    }
  }
  return [...found.values()]
}

function isDefRegistry(
  value: object,
): value is { readonly namespace: string; readonly defs: Record<string, CommandDef> } {
  const candidate = value as { namespace?: unknown; defs?: unknown }
  return typeof candidate.namespace === 'string' && typeof candidate.defs === 'object'
}

function isContract(value: unknown): value is AnyCommandContract {
  if (value === null || typeof value !== 'object') return false
  const candidate = value as Partial<AnyCommandContract>
  return (
    typeof candidate.name === 'string' &&
    Array.isArray(candidate.exposure) &&
    typeof candidate.delivery === 'object' &&
    typeof candidate.policy === 'object'
  )
}
