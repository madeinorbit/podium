/**
 * The covered surface of the golden wire fixtures (POD-360).
 *
 * Families are the protocol's module split PLUS @podium/model's barrel,
 *
 * The `ids` family is GONE as of POD-361, and that is a relocation, not a
 * coverage loss: the brands and the two composite-key helpers moved to
 * @podium/model, so every schema `ids.json` pinned now appears in the `model`
 * family — asserted case-by-case in the POD-361 handoff before the golden was
 * regenerated (docs/rearch-branded-id-flip.md §9), because a regeneration is
 * exactly what would otherwise let a deletion pass as a move.
 *
 * so "every message family" is a mechanical fact rather than a list someone has to
 * remember to extend: each module contributes EVERY zod schema it exports.
 *
 * The `model` family exists because POD-300 moved 67 entity schemas out of protocol
 * into @podium/model. This registry REFLECTS over export surfaces, so without them
 * the relocation would have silently dropped those schemas' byte pin and the suite
 * would have gone green on reduced coverage — a relocation read as a deletion,
 * which is the exact failure class the deletion audit exists to catch. Coverage
 * follows the schemas to their new home instead. protocol -> model is a legal
 * dependency direction after POD-300. Add a message type, and its
 * fixture appears the next time the golden is regenerated — and CI fails until
 * someone regenerates it and looks at the diff. That is the point.
 */

import * as model from '@podium/model'
import { z } from 'zod'
import * as maintenance from '../maintenance'
import * as approvals from '../messages/approvals'
import * as automations from '../messages/automations'
import * as browserOpen from '../messages/browser-open'
import * as client from '../messages/client'
import * as control from '../messages/control'
import * as credentials from '../messages/credentials'
import * as daemon from '../messages/daemon'
import * as daemonHandshake from '../messages/daemon-handshake'
import * as discovery from '../messages/discovery'
import * as dispatch from '../messages/dispatch'
import * as feed from '../messages/feed'
import * as files from '../messages/files'
import * as handoff from '../messages/handoff'
import * as harness from '../messages/harness'
import * as headless from '../messages/headless'
import * as host from '../messages/host'
import * as inventory from '../messages/inventory'
import * as issues from '../messages/issues'
import * as localLink from '../messages/local-link'
import * as messageClass from '../messages/message-class'
import * as runtimeState from '../messages/runtime-state'
import * as search from '../messages/search'
import * as server from '../messages/server'
import * as sync from '../messages/sync'
import * as terminal from '../messages/terminal'
import * as transcript from '../messages/transcript'
import * as workflows from '../messages/workflows'
import * as workspace from '../messages/workspace'
import * as perf from '../perf'
import * as presenceRooms from '../planes/presence-rooms'

/** One fixture family == one protocol module. The name is the golden filename. */
const MODULES: ReadonlyArray<readonly [family: string, module: Record<string, unknown>]> = [
  ['approvals', approvals],
  ['model', model],
  ['automations', automations],
  ['browser-open', browserOpen],
  ['client', client],
  ['control', control],
  ['credentials', credentials],
  ['daemon', daemon],
  ['daemon-handshake', daemonHandshake],
  ['discovery', discovery],
  ['dispatch', dispatch],
  ['feed', feed],
  ['files', files],
  ['handoff', handoff],
  ['harness', harness],
  ['headless', headless],
  ['host', host],
  ['inventory', inventory],
  ['issues', issues],
  ['local-link', localLink],
  ['maintenance', maintenance],
  ['message-class', messageClass],
  ['perf', perf],
  ['presence-rooms', presenceRooms],
  ['runtime-state', runtimeState],
  ['search', search],
  ['server', server],
  ['sync', sync],
  ['terminal', terminal],
  ['transcript', transcript],
  ['workflows', workflows],
  ['workspace', workspace],
]

/**
 * The aggregate transport unions. Every arm of each is a schema exported in its
 * own right, so sampling the union by arm index would duplicate 40+ large cases
 * to cover 8 of them. Instead they are excluded here and the fixture test
 * asserts, arm by arm, that each member IS covered — which is a stronger
 * completeness claim than sampling would have been.
 */
export const AGGREGATE_UNIONS: ReadonlyArray<readonly [name: string, schema: z.ZodTypeAny]> = [
  ['ClientMessage', client.ClientMessage],
  ['ServerMessage', server.ServerMessage],
  ['DaemonMessage', daemon.DaemonMessage],
  ['ControlMessage', control.ControlMessage],
  ['DaemonHandshake', daemonHandshake.DaemonHandshake],
  ['DaemonHandshakeReply', daemonHandshake.DaemonHandshakeReply],
]

const AGGREGATE_NAMES = new Set(AGGREGATE_UNIONS.map(([name]) => name))

export interface CoveredSchema {
  family: string
  name: string
  schema: z.ZodTypeAny
}

const isSchema = (value: unknown): value is z.ZodTypeAny => value instanceof z.ZodType

/**
 * Every zod schema the protocol package exports, grouped by module.
 *
 * A schema re-exported under a second name in the same module (zod's
 * `export const X` + `export type X` pattern produces one value) is listed
 * once per NAME it is exported as; that is deliberate — the name is part of
 * the wire contract's public surface.
 */
export const coveredSchemas = (): CoveredSchema[] => {
  const out: CoveredSchema[] = []
  for (const [family, module] of MODULES) {
    for (const [name, value] of Object.entries(module)) {
      if (!isSchema(value)) continue
      if (AGGREGATE_NAMES.has(name)) continue
      out.push({ family, name, schema: value })
    }
  }
  // Stable order: golden files must not reshuffle because a bundler changed
  // export enumeration order.
  return out.sort((a, b) => a.family.localeCompare(b.family) || a.name.localeCompare(b.name))
}

/** Families in golden-file order. */
export const families = (): string[] => [...new Set(coveredSchemas().map((s) => s.family))].sort()
