const RETIRED_POOL_SWITCHES = new Set(['mobxSidebar', 'mobxSidebarCheck', 'mobxHeader', 'mobxHeaderCheck', 'mobxChips', 'mobxChipsCheck', 'mobxPane', 'mobxPaneCheck', 'mobxSessionPane', 'mobxSessionPaneCheck', 'mobxBoard', 'mobxBoardCheck', 'mobxShell', 'mobxShellCheck'])

export type SpeedSwitch = readonly [key: string, value: '0' | '1']

/** Repeatable URL overrides; every unspecified startup setting stays intact. */
export function parseSpeedSwitches(args: readonly string[]): SpeedSwitch[] {
  const switches = new Map<string, '0' | '1'>()
  for (const arg of args) {
    if (!arg.startsWith('--switch=')) continue
    const match = /^--switch=([^=]+)=(0|1)$/.exec(arg)
    if (!match || match[1]!.trim() !== match[1]) throw new Error(`Invalid switch override ${arg}`)
    const key = match[1]!, value = match[2] as '0' | '1'
    if (RETIRED_POOL_SWITCHES.has(key)) continue
    if (switches.has(key) && switches.get(key) !== value) throw new Error(`Conflicting switch override ${key}`)
    switches.set(key, value)
  }
  return [...switches]
}

export function speedSwitchUrl(url: string, switches: readonly SpeedSwitch[]): string {
  if (!switches.length) return url
  const target = new URL(url)
  for (const [key, value] of switches) target.searchParams.set(key, value)
  return target.toString()
}

/** The fixture records the URL values at boot, before screen initialization. */
export function speedSwitchState(search: string): Record<string, string> {
  return Object.fromEntries(new URLSearchParams(search))
}

export function assertSpeedSwitches(state: Readonly<Record<string, string>>, switches: readonly SpeedSwitch[]): void {
  for (const [key, value] of switches) {
    if (state[key] !== value) throw new Error(`Switch override ${key}=${value} did not reach the page startup state`)
  }
}

/** No extra field, including an empty one, in the default report. */
export function speedSwitchReport(switches: readonly SpeedSwitch[]): { switches?: Record<string, string> } {
  return switches.length ? { switches: Object.fromEntries(switches) } : {}
}
