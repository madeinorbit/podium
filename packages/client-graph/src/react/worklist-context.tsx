import { createContext, useContext, type ReactNode } from 'react'
import type { Worklist } from '../worklist/view-model'

const WorklistContext = createContext<Worklist | null>(null)

export function WorklistProvider({ model, children }: { model: Worklist | null; children: ReactNode }) {
  return <WorklistContext.Provider value={model}>{children}</WorklistContext.Provider>
}

export function useWorklistModel(): Worklist | null { return useContext(WorklistContext) }
