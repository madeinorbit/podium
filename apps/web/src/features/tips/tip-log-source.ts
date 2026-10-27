import { useState } from 'react'
import { MemoryTipLog } from './memory-tip-log'
import type { TipLog } from './types'

export function useTipLogSource(): TipLog {
  return useState(() => new MemoryTipLog())[0]
}
