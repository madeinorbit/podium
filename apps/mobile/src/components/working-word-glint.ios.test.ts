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

  it('hands the glint to Core Animation only for visible, focused, foreground words', () => {
    expect(code).not.toMatch(/TimelineView|CADisplayLink|ObservableObject|Timer/)
    expect(code).toContain('if active && visible && foreground && !reduceMotion {')
    expect(code).toContain('.modifier(ContentVisibilityModifier { visible = $0 })')
    expect(code).toContain('UIApplication.willResignActiveNotification')
    expect(code).toContain('UIApplication.didBecomeActiveNotification')
    expect(code).toContain('travel.repeatCount = .infinity')
    expect(code).toContain('host.view.layer.mask = glintWindow')
  })

  it('keeps the desktop timing on the shared absolute clock with the seed phase', () => {
    expect(code).toContain('period: CFTimeInterval = 2.2')
    expect(code).toContain('travel.values = [-0.4 * width, width, width]')
    expect(code).toContain('travel.keyTimes = [0, 0.66, 1]')
    expect(code).toContain('CAMediaTimingFunction(controlPoints: 0.42, 0, 0.58, 1)')
    expect(code).toContain(
      'Date().timeIntervalSinceReferenceDate.truncatingRemainder(dividingBy: Self.period)',
    )
    expect(code).toContain('travel.timeOffset = phase * Self.period')
  })

  it('draws nothing and runs no animation under Reduce Motion', () => {
    expect(code).toMatch(/@Environment\(\\\.accessibilityReduceMotion\)/)
    const gate = code.indexOf('if active && visible && foreground && !reduceMotion {')
    expect(gate).toBeGreaterThan(-1)
    expect(code.indexOf('WorkingGlintOverlay(')).toBeGreaterThan(gate)
  })

  it('draws the copy in the row Text font and sends the row string', () => {
    // @expo/ui font({ textStyle }) resolves to Font.system(style, design: .default).
    expect(code).toContain('.font(.system(textStyle, design: .default))')
    expect(code).toContain('.lineLimit(1)')
    expect(bridge).toMatch(/createModifier\('podiumWorkingWordGlint', \{[^}]*\btext,\s*textStyle,?\s*\}/)
    expect(registration).toContain('text: params["text"] as? String')
  })

  it('registers the modifier under the name the JS bridge sends', () => {
    const name = /createModifier\('([^']+)'/.exec(bridge)?.[1]
    expect(name).toBe('podiumWorkingWordGlint')
    expect(registration).toContain(`private let workingWordModifier = "${name}"`)
    expect(registration).toMatch(
      /ViewModifierRegistry\.register\(workingWordModifier\)[^}]*WorkingWordModifier\(\s*phase:/,
    )
  })
})
