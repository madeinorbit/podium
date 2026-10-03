// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from 'vitest'
import {
  assertSpeedSwitches,
  parseSpeedSwitches,
  speedSwitchReport,
  speedSwitchState,
  speedSwitchUrl,
} from '../harness/speed-switches'

afterEach(() => history.replaceState(null, '', '/'))
describe('generic speed gate URL overrides', () => {
  it('parses repeatable overrides and rejects malformed or conflicting values', () => {
    expect(
      parseSpeedSwitches([
        '--switch=mobxCommands=0',
        '--lease-confirmed',
        '--switch=anotherSetting=1',
        '--switch=mobxCommands=0',
      ]),
    ).toEqual([
      ['mobxCommands', '0'],
      ['anotherSetting', '1'],
    ])
    for (const arg of [
      '--switch=mobxCommands=2',
      '--switch==1',
      '--switch=mobxCommands',
      '--switch= spaced=0',
    ]) {
      expect(() => parseSpeedSwitches([arg])).toThrow(/Invalid/)
    }
    expect(() =>
      parseSpeedSwitches(['--switch=mobxCommands=0', '--switch=mobxCommands=1']),
    ).toThrow(/Conflicting/)
  })

  it('preserves the default URL and report bytes and records only requested overrides', () => {
    const url = 'http://FIXTURE.test:80/path?literal=hello%20world&mobxSidebar=1'
    expect(speedSwitchUrl(url, [])).toBe(url)
    const report = { version: 1, delayMs: 0, passed: true }
    expect(JSON.stringify({ ...report, ...speedSwitchReport([]) })).toBe(JSON.stringify(report))
    expect(speedSwitchReport([['mobxPane', '0']])).toEqual({ switches: { mobxPane: '0' } })
  })

  it('forwards overrides into the page startup state while preserving other URL settings', () => {
    const switches = parseSpeedSwitches(['--switch=mobxCommands=1', '--switch=mobxCommandsCheck=1'])
    const original = `${location.origin}/fixture?mobxSidebar=1&scale=4&mobxPane=0&mobxCommands=0`
    // The document receives the same goto URL as the browser; the state is
    // captured by the same boot reader used in the actual acceptance fixture.
    history.replaceState(null, '', speedSwitchUrl(original, switches))
    const page = { state: () => ({ switches: speedSwitchState(location.search) }) }
    assertSpeedSwitches(page.state().switches, switches)
    expect(page.state().switches).toMatchObject({ mobxSidebar: '1', scale: '4', mobxPane: '0' })
  })

  it('refuses a missing or wrong override in the page startup state', () => {
    expect(() => assertSpeedSwitches({}, [['setting', '1']])).toThrow(/did not reach/)
    expect(() => assertSpeedSwitches({ setting: '0' }, [['setting', '1']])).toThrow(/did not reach/)
  })
})

it('drops retired workspace overrides while retaining switches for the other lanes', () => {
  expect(
    parseSpeedSwitches([
      '--switch=mobxSidebar=0',
      '--switch=mobxPane=1',
      '--switch=mobxHeader=0',
      '--switch=mobxCommands=1',
    ]),
  ).toEqual([['mobxCommands', '1']])
})
