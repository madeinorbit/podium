import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const appSource = readFileSync(join(import.meta.dir, '../src/App.tsx'), 'utf8')

describe('Podium prototype information architecture', () => {
  test('uses work modes instead of a feature-browser section rail', () => {
    expect(appSource).toContain("type ModeId = 'product' | 'dev' | 'spec' | 'search' | 'settings'")
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
