import { useAccountTipLog } from './account-tip-log'
import type { TipLog } from './types'

export function useTipLogSource(): TipLog {
  return useAccountTipLog()
}
