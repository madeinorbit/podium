import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, test } from 'vitest'

const dir = dirname(fileURLToPath(import.meta.url))
const appSource = readFileSync(join(dir, '../src/App.tsx'), 'utf8')

describe('Podium prototype information architecture', () => {
  test('uses work modes instead of a feature-browser section rail', () => {
    expect(appSource).toContain(
      "type ModeId = 'product' | 'dev' | 'spec' | 'search' | 'settings' | 'live'",
    )
    expect(appSource).not.toContain('type SectionId =')
    expect(appSource).not.toContain('function FeatureSurface')
  })

  test('places major features inside real workflows', () => {
    expect(appSource).toContain('ContextComposer')
    expect(appSource).toContain('HistoryWorkspace')
    expect(appSource).toContain('EnvironmentSetup')
    expect(appSource).toContain('SkillsAccessSettings')
    expect(appSource).toContain('NotificationRules')
    expect(appSource).toContain('UsageLedger')
    expect(appSource).toContain('DevWorkbench')
  })
})
