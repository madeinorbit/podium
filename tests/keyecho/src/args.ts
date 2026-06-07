import type { Mode } from './sources/types.js'

export interface Options {
  mode: Mode
  lock: boolean
}

const MODES: Mode[] = ['raw', 'ink', 'both']

export function parseArgs(argv: string[]): Options {
  let mode: Mode = 'both'
  let lock = false
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--mode') {
      const m = argv[i + 1] as Mode
      if (MODES.includes(m)) mode = m
      i += 1
    } else if (argv[i] === '--lock') {
      lock = true
    }
  }
  return { mode, lock }
}
