import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const modifier = readFileSync(
  resolve(process.cwd(), 'modules/podium-list-row/ios/WorkingWordModifier.swift'),
  'utf8',
)
const registration = readFileSync(
  resolve(process.cwd(), 'modules/podium-list-row/ios/PodiumListRowModule.swift'),
  'utf8',
)
const bridge = readFileSync(
  resolve(process.cwd(), 'src/components/working-word-glint.ios.ts'),
  'utf8',
)
/** Swift without comments, so prose about a pitfall never satisfies or trips a check. */
const code = modifier.replace(/\/\/.*$/gm, '')

describe('native Working glint', () => {
  it('never gates motion on scenePhase, which hosted SwiftUI reads as background', () => {
    // @expo/ui hosts SwiftUI outside a SwiftUI scene, so scenePhase stays .background.
    // Gating the clock on it left every Working word static on device (POD-2626).
    expect(code).not.toMatch(/scenePhase/)
  })

  it('runs from a system animation timeline, not an onAppear-gated subscription', () => {
    expect(code).toMatch(/TimelineView\(\.animation\(minimumInterval: 1\.0 \/ 30\)\)/)
    expect(code).not.toMatch(/CADisplayLink|ObservableObject|\.onAppear|@State/)
    // The glint offset is derived from the timeline's own date.
    expect(code).toMatch(/glintOffset\(at: timeline\.date/)
  })

  it('draws nothing and runs no timeline under Reduce Motion', () => {
    expect(code).toMatch(/@Environment\(\\\.accessibilityReduceMotion\)/)
    const gate = code.indexOf('if !reduceMotion {')
    expect(gate).toBeGreaterThan(-1)
    expect(code.indexOf('TimelineView(')).toBeGreaterThan(gate)
  })

  it('registers the modifier under the name the JS bridge sends', () => {
    const name = /createModifier\('([^']+)'/.exec(bridge)?.[1]
    expect(name).toBe('podiumWorkingWordGlint')
    expect(registration).toContain(`private let workingWordModifier = "${name}"`)
    expect(registration).toMatch(
      /ViewModifierRegistry\.register\(workingWordModifier\)[^}]*WorkingWordModifier\(phase:/,
    )
  })
})
