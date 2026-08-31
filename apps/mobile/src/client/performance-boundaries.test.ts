import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const client = (name: string) => readFileSync(resolve(import.meta.dirname, name), 'utf8')

describe('mobile performance boundaries', () => {
  it("keeps the web and native persistence engines out of each other's bundles", () => {
    const provider = client('MobileClientProvider.tsx')
    const web = client('mobile-entity-store.web.ts')
    const native = client('mobile-entity-store.native.ts')

    expect(provider).toContain("from './mobile-entity-store'")
    expect(provider).not.toMatch(
      /['"](?:expo-sqlite|@podium\/sync\/adapters\/(?:indexeddb|mobile-sqlite))['"]/,
    )

    expect(web).toContain('@podium/sync/adapters/indexeddb')
    expect(web).not.toMatch(/['"](?:expo-sqlite|@podium\/sync\/adapters\/mobile-sqlite)['"]/)

    expect(native).toMatch(/from ['"]expo-sqlite['"]/)
    expect(native).toContain('@podium/sync/adapters/mobile-sqlite')
    expect(native).not.toMatch(/['"]@podium\/sync\/adapters\/indexeddb['"]/)
  })

  it('passes published slice identities into the shared mission-progress cache', () => {
    const workScreen = readFileSync(
      resolve(import.meta.dirname, '../screens/WorkScreen.tsx'),
      'utf8',
    )

    expect(workScreen).toContain('missionProgress(issues, allSessions, issue.id)')
    expect(workScreen).not.toMatch(/missionProgress\(\[\.\.\./)
    expect(workScreen).not.toMatch(/issueDisplayTitle\([^\n]*\[\.\.\./)
  })
})
