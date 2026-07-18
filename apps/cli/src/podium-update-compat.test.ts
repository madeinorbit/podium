import { describe, expect, it } from 'vitest'
import { reviveCompatibilityBlockedJanitor } from './podium-update'

describe('janitor compatibility revival [spec:SP-c29e]', () => {
  it('resets and starts only the instance janitor stopped on compatibility exit 78', () => {
    const calls: string[][] = []
    const exec = (_command: string, args: string[]): string => {
      calls.push(args)
      return args.includes('show') ? '78\n' : ''
    }

    expect(reviveCompatibilityBlockedJanitor('blue', exec)).toBe(true)
    expect(calls).toEqual([
      ['--user', 'show', 'podium-blue-janitor.service', '--property=ExecMainStatus', '--value'],
      ['--user', 'reset-failed', 'podium-blue-janitor.service'],
      ['--user', 'start', 'podium-blue-janitor.service'],
    ])
  })

  it('does not disturb a healthy or absent janitor unit', () => {
    const calls: string[][] = []
    const exec = (_command: string, args: string[]): string => {
      calls.push(args)
      return '0\n'
    }

    expect(reviveCompatibilityBlockedJanitor('default', exec)).toBe(false)
    expect(calls).toEqual([
      ['--user', 'show', 'podium-janitor.service', '--property=ExecMainStatus', '--value'],
    ])
  })
})
