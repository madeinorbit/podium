/**
 * What each bundled harness adapter accepts, checked against the credential
 * type registry (credential management spec §5, plan Task 1).
 *
 * Nothing here lists (adapter, type) pairs by hand: the matrix is read off
 * `AGENT_MANIFESTS` and `CREDENTIAL_TYPES` at run time, so a new adapter or a
 * new type is checked without editing this file.
 */

import {
  type AcceptsConsumer,
  acceptsProblems,
  CREDENTIAL_TYPES,
  type CredentialTypeId,
  INFERENCE_ROUTES,
} from '@podium/model'
import { describe, expect, it } from 'vitest'
import { codexApiKeyProviderArgs, codexPlanProviderArgs } from './adapters/codex/plan-provider.js'
import { BUNDLED_DESCRIPTORS } from './browser.js'
import { buildBundledDescriptors, buildServedDescriptors } from './descriptors.js'
import { declaredValue } from './manifest.js'
import { harnessAccepts, harnessHideFromCommands } from './metadata.js'
import { AGENT_MANIFESTS } from './registry.js'

const bundled = (): AcceptsConsumer[] =>
  Object.values(AGENT_MANIFESTS).map((manifest) => ({
    kind: manifest.kind,
    accepts: manifest.inventory.accepts,
  }))

const problemsOf = (consumers: AcceptsConsumer[]) =>
  acceptsProblems({ types: CREDENTIAL_TYPES, routes: INFERENCE_ROUTES, consumers })

describe('credential matrix over the registry and every bundled adapter', () => {
  it('has no unused type, no unknown type id and no ambiguous duplicate', () => {
    expect(bundled().length).toBeGreaterThanOrEqual(6)
    expect(problemsOf(bundled())).toEqual([])
  })

  it('probe: a type accepted by no adapter and with no inference route fails', () => {
    // Pick, from the data, a type no route serves; drop every adapter line for it.
    const unrouted = (Object.keys(CREDENTIAL_TYPES) as CredentialTypeId[]).find(
      (type) => INFERENCE_ROUTES[type] === undefined,
    )
    expect(unrouted).toBeDefined()
    const consumers = bundled().map((consumer) => ({
      ...consumer,
      accepts: consumer.accepts.filter((line) => line.type !== unrouted),
    }))
    expect(problemsOf(consumers)).toEqual([{ kind: 'unused-type', type: unrouted }])
  })

  it('probe: an adapter accepting a type id outside the registry fails', () => {
    const [first, ...rest] = bundled()
    if (!first) throw new Error('no bundled adapters')
    const consumers = [
      { ...first, accepts: [...first.accepts, { type: 'example.not-a-type' }] },
      ...rest,
    ]
    expect(problemsOf(consumers)).toEqual([
      { kind: 'unknown-type', consumer: first.kind, type: 'example.not-a-type' },
    ])
  })

  it('probe: one adapter accepting the same type twice for overlapping drivers fails', () => {
    const consumers = bundled()
    const index = consumers.findIndex((consumer) => consumer.accepts.length > 0)
    const target = consumers[index]
    const line = target?.accepts[0]
    if (!target || !line) throw new Error('no adapter accepts anything')
    // A copy of an existing line: same type, same drivers, so they overlap.
    consumers[index] = { ...target, accepts: [...target.accepts, { ...line }] }
    expect(problemsOf(consumers)).toEqual([
      { kind: 'duplicate-type', consumer: target.kind, type: line.type },
    ])
  })
})

describe('harnessAccepts', () => {
  it('Claude Code accepts the key, the token and its own login', () => {
    expect(harnessAccepts('claude-code')).toEqual([
      { type: 'anthropic.api-key', deliver: { kind: 'env', variable: 'ANTHROPIC_API_KEY' } },
      {
        type: 'anthropic.claude-token',
        deliver: { kind: 'env', variable: 'CLAUDE_CODE_OAUTH_TOKEN' },
      },
      { type: 'anthropic.claude-login', deliver: { kind: 'home' } },
    ])
  })

  it('Codex accepts the key, its own login, and the ChatGPT plan on its server driver only', () => {
    expect(harnessAccepts('codex')).toEqual([
      {
        type: 'openai.api-key',
        deliver: { kind: 'env', variable: 'OPENAI_API_KEY' },
        // Only in the Podium home, which holds no Codex login (POD-7271).
        homeStartArgs: codexApiKeyProviderArgs(),
      },
      { type: 'openai.chatgpt-login', deliver: { kind: 'home' } },
      {
        type: 'openai.chatgpt-plan',
        deliver: { kind: 'env', variable: 'ACCESS_TOKEN' },
        drivers: ['codex-app-server'],
        startArgs: codexPlanProviderArgs(),
      },
    ])
  })

  it('Grok accepts only its own login, held in a home (no passed-in line yet)', () => {
    expect(harnessAccepts('grok')).toEqual([{ type: 'xai.grok-login', deliver: { kind: 'home' } }])
  })

  it('no harness delivers two lines in one variable: the start reads its line off the variable', () => {
    for (const manifest of Object.values(AGENT_MANIFESTS)) {
      const variables = manifest.inventory.accepts.flatMap((line) =>
        line.deliver.kind === 'env' ? [line.deliver.variable] : [],
      )
      expect(new Set(variables).size, manifest.kind).toBe(variables.length)
    }
  })

  it('start arguments stay off the wire descriptor', () => {
    const codex = buildBundledDescriptors().find((descriptor) => descriptor.kind === 'codex')
    expect(JSON.stringify(codex?.accepts)).not.toContain('startArgs')
    expect(JSON.stringify(codex?.accepts)).not.toContain('homeStartArgs')
  })

  it('names only drivers the adapter declares', () => {
    for (const manifest of Object.values(AGENT_MANIFESTS)) {
      const { server, serverAlternatives, embedded, terminal } = manifest.runtime
      const ids: (string | undefined)[] = [
        declaredValue(server)?.driverId,
        ...(serverAlternatives ?? []).map((spec) => spec.driverId),
        declaredValue(embedded)?.driverId,
        terminal.driverId,
      ]
      const declared = new Set(ids.filter((id): id is string => id !== undefined))
      for (const line of manifest.inventory.accepts) {
        for (const driver of line.drivers ?? []) {
          expect(declared.has(driver), `${manifest.kind} ${line.type} ${driver}`).toBe(true)
        }
      }
    }
  })

  it('is empty for a harness this build has never heard of', () => {
    expect(harnessAccepts('not-a-harness')).toEqual([])
  })
})

describe('hideFromCommands', () => {
  it('Claude Code scrubs credentials from the commands it runs', () => {
    expect(harnessHideFromCommands('claude-code')).toEqual({
      env: { CLAUDE_CODE_SUBPROCESS_ENV_SCRUB: '1' },
    })
  })

  it('Codex excludes exactly the variables its env lines deliver, and nothing else', () => {
    expect(harnessHideFromCommands('codex')).toEqual({
      args: ['-c', 'shell_environment_policy.exclude=["OPENAI_API_KEY","ACCESS_TOKEN"]'],
    })
    // Derived, not restated: the excluded names are the env deliveries of its accepts.
    const [flag, setting] = harnessHideFromCommands('codex')?.args ?? []
    expect(flag).toBe('-c')
    const excluded = JSON.parse(setting?.replace('shell_environment_policy.exclude=', '') ?? '[]')
    const delivered = harnessAccepts('codex').flatMap((line) =>
      line.deliver.kind === 'env' ? [line.deliver.variable] : [],
    )
    expect(excluded).toEqual(delivered)
    expect(excluded).not.toContain('GH_TOKEN')
  })
})

describe('accepts on the descriptor wire', () => {
  it("served, built and bundled descriptors carry each harness's accepts", () => {
    const served = buildServedDescriptors({ os: 'linux', arch: 'arm64', agents: [], tools: [] })
    for (const set of [served, buildBundledDescriptors(), [...BUNDLED_DESCRIPTORS]]) {
      expect(set.length).toBe(Object.keys(AGENT_MANIFESTS).length)
      for (const descriptor of set) {
        // The wire carries every line, without the start arguments: those are
        // read by the daemon off its own manifest.
        const wire = harnessAccepts(descriptor.kind).map(
          ({ startArgs: _local, homeStartArgs: _home, ...line }) => line,
        )
        expect(descriptor.accepts, descriptor.kind).toEqual(wire)
      }
    }
    // Not vacuous: some descriptor carries a line.
    expect(served.some((descriptor) => descriptor.accepts.length > 0)).toBe(true)
  })
})
