/**
 * EVERY RELAY WRITE IS ACCOUNTED FOR (ADR 12 D9, POD-6593).
 *
 * The relay's allowlist (`issues/relay-gate.ts`) decides what an agent can
 * reach; the census (`write-routes/relay.ts`) says how each proc writes: a read,
 * a generated adapter, an arm submitting a named sync registration, an effect
 * on a machine with no synced write, or a direct write with its owner issue.
 * A proc the allowlist serves and the census does not list fails here, so a
 * new writing arm cannot appear unlisted. The routers the allowlist opens whole
 * are checked through their families' tables against the registries.
 */

import { isExposedOn } from '@podium/commands'
import { afterEach, describe, expect, it } from 'vitest'
import { issueRegistry } from '../issues/registry'
import { RELAY_ALLOWED } from '../issues/relay-gate'
import { lockRegistry } from '../lock/registry'
import { plainCommands } from '../plain-command/commands'
import { disposeOracles, makeOracle } from '../sessions/oracle-support'
import { SPEC_COMMANDS_TRPC } from '../specs/registry'
import { WORKFLOW_COMMANDS } from '../workflows/registry'
import { DIRECT_WRITE_OWNERS, isDirectWrite } from './direct'
import { RELAY_ARMS, RELAY_FAMILY_ROUTERS } from './relay'

afterEach(() => disposeOracles())

/** Every `router.proc` the allowlist names proc by proc. */
const listedProcs = (): string[] =>
  Object.entries(RELAY_ALLOWED).flatMap(([router, procs]) =>
    procs === null ? [] : [...procs].map((proc) => `${router}.${proc}`),
  )

const wholeRouters = (): string[] =>
  Object.entries(RELAY_ALLOWED)
    .filter(([, procs]) => procs === null)
    .map(([router]) => router)

const relayPlain = (name: string): boolean =>
  plainCommands().lookup(name)?.door.exposedOn('relay') === true

describe('the relay census', () => {
  it('lists exactly the procs the allowlist serves proc by proc', () => {
    expect(Object.keys(RELAY_ARMS).sort()).toEqual(listedProcs().sort())
  })

  it('names exactly the routers the allowlist opens whole', () => {
    expect(Object.keys(RELAY_FAMILY_ROUTERS).sort()).toEqual(wholeRouters().sort())
  })

  it('every registration an arm names exists on the path it says', async () => {
    const o = await makeOracle()
    const sync = o.reg.modules.syncWrite.registry
    const missing: string[] = []
    for (const [name, arm] of Object.entries(RELAY_ARMS)) {
      if (arm.kind === 'entry' && arm.registration !== '*') {
        if (sync.lookup(arm.registration) === undefined)
          missing.push(`${name}: ${arm.registration}`)
      }
      if (arm.kind === 'adapter') {
        const exists = arm.via === 'plain' ? relayPlain(name) : sync.lookup(name) !== undefined
        if (!exists) missing.push(`${name}: no ${arm.via} registration`)
      }
    }
    expect(missing).toEqual([])
  })

  it('every direct relay write is owned by an issue that moves it onto a registration', () => {
    const owners: readonly string[] = DIRECT_WRITE_OWNERS
    const strays = Object.entries(RELAY_ARMS)
      .filter(([, arm]) => arm.kind === 'direct' && !owners.includes(arm.owner))
      .map(([name]) => name)
    expect(strays).toEqual([])
  })
})

describe('the routers the relay opens whole', () => {
  it('every issue write is a sync registration or a direct write', async () => {
    const o = await makeOracle()
    const sync = o.reg.modules.syncWrite.registry
    const unregistered = Object.entries(issueRegistry.defs)
      .filter(([, def]) => def.kind === 'mutation')
      .map(([proc]) => `issues.${proc}`)
      .filter((name) => sync.lookup(name) === undefined && !isDirectWrite(name))
    expect(unregistered).toEqual([])
  })

  // The spec and workflow command tables hold writes only; their reads are queries.
  it('every spec write on the relay is a plain registration', () => {
    const missing = Object.values(SPEC_COMMANDS_TRPC)
      .map(({ contract }) => contract)
      .filter((contract) => contract.exposure.includes('relay'))
      .map((contract) => contract.name)
      .filter((name) => !relayPlain(name))
    expect(missing).toEqual([])
  })

  it('every lock write on the relay is a plain registration', () => {
    const missing = Object.entries(lockRegistry.defs)
      .filter(([, def]) => def.kind === 'mutation' && isExposedOn(def, 'relay'))
      .map(([proc]) => `lock.${proc}`)
      .filter((name) => !relayPlain(name))
    expect(missing).toEqual([])
  })

  it('every workflow write on the relay is a sync registration', async () => {
    const o = await makeOracle()
    const sync = o.reg.modules.syncWrite.registry
    const missing = Object.values(WORKFLOW_COMMANDS)
      .map(({ contract }) => contract)
      .filter((contract) => contract.exposure.includes('relay'))
      .map((contract) => contract.name)
      .filter((name) => sync.lookup(name) === undefined)
    expect(missing).toEqual([])
  })
})
