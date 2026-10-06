import { createContext } from 'react'
import type { Pool } from './store'

/** The pool handed down to components. The P3 probe's aliased row reads it (`shared/src/probes/row-scan.ts`). */
export const PoolContext = createContext<Pool | null>(null)
