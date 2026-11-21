import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import {
  declinedContext,
  type HarnessContextSection,
  type HarnessContextStrategy,
} from '../packages/harness/src/context-types'
import { claudeSdkCapabilities } from '../packages/harness/src/driver/families/claude-sdk/capabilities'
import { codexAppServerCapabilities } from '../packages/harness/src/driver/families/codex/capabilities'
import { grokAcpCapabilities } from '../packages/harness/src/driver/families/grok-acp/capabilities'
import { opencodeServerCapabilities } from '../packages/harness/src/driver/families/opencode/capabilities'
import { DRIVER_IDS, declinedReasonIsValid } from '../packages/harness/src/manifest'
import {
  AGENT_MANIFESTS,
  contextCapabilityFor,
  contextStrategyFor,
  sectionStatusesOf,
} from '../packages/harness/src/registry'
import { checkFile, extractImports } from './check-boundaries'

const root = fileURLToPath(new URL('../', import.meta.url))
const hostFree = [
  'packages/model/src/context.ts',
  'packages/harness/src/context-types.ts',
  'packages/harness/src/driver/context.ts',
]

describe('context contract import boundaries', () => {
  it.each(hostFree)('%s imports only neutral value/type modules', (file) => {
    const source = readFileSync(root + file, 'utf8')
    expect(checkFile(file, source)).toEqual([])
    const imports = extractImports(source)
    expect(imports.length).toBeGreaterThan(0)
    for (const ref of imports) {
      expect(ref.specifier).not.toMatch(
        /(?:node:|bun:|families\/|adapters\/|model-catalog|node_modules)/,
      )
      if (file.startsWith('packages/model/')) expect(ref.specifier).toBe('zod')
    }
    expect(source).not.toMatch(/\b(?:process|Bun)\./)
  })
  it('declares every harness/driver combination with a real default decline', () => {
    for (const [harness, adapter] of Object.entries(AGENT_MANIFESTS)) {
      for (const driver of DRIVER_IDS) {
        const declaration = contextStrategyFor(harness, driver)
        expect(declaration, `${harness}/${driver}`).toEqual(
          adapter.runtime.context.forDriver(driver),
        )
        expect(declaration.supported, `${harness}/${driver}`).toBe(false)
        if (!declaration.supported) expect(declinedReasonIsValid(declaration.reason)).toBe(true)
        expect(contextCapabilityFor(harness, driver)).toEqual(declaration)
        expect(sectionStatusesOf(adapter)).toContainEqual({
          section: `runtime.context.${driver}`,
          supported: false,
          reason: !declaration.supported ? declaration.reason : undefined,
        })
      }
    }
    expect(contextStrategyFor('invented-unregistered', 'generic-pty')).toMatchObject({
      supported: false,
    })
    expect(() => declinedContext(' ')).toThrow('reason')
  })
  it('family capabilities report the adapter declaration rather than assuming native availability', () => {
    for (const [harness, driver, capability] of [
      ['codex', 'codex-app-server', codexAppServerCapabilities()],
      ['claude-code', 'claude-sdk', claudeSdkCapabilities()],
      ['opencode', 'opencode-server', opencodeServerCapabilities()],
      ['opencode', 'opencode2-server', opencodeServerCapabilities('opencode2-server')],
      ['grok', 'grok-acp', grokAcpCapabilities()],
    ] as const)
      expect(capability.context).toEqual(contextCapabilityFor(harness, driver))
  })
  it('keys support by mechanism without involving a consumer harness switch', async () => {
    const strategy: HarnessContextStrategy = {
      capability: { summary: 'explicit', detail: 'none' },
      probe: async () => ({ status: 'available' }),
      bind: () => {
        throw new Error('This declaration-only fixture has no session')
      },
    }
    const section: HarnessContextSection = {
      forDriver: (driver) =>
        driver === 'fake'
          ? { supported: true, value: strategy }
          : declinedContext('This synthetic transport has no context measurement').forDriver(
              driver,
            ),
    }
    expect(section.forDriver('generic-pty')).toMatchObject({ supported: false })
    const supported = section.forDriver('fake')
    expect(supported.supported).toBe(true)
    if (supported.supported)
      expect(await supported.value.probe({ timeoutMs: 500 })).toEqual({ status: 'available' })
    // Machine admission never produces a measured zero or a current sample.
    expect(await strategy.probe({ timeoutMs: 500 })).not.toHaveProperty('occupancy')
  })
})
