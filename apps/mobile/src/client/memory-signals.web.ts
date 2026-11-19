import { browserMemorySignals, type MemorySignals } from '@podium/sync/replica'

/** The phone app in a browser: the browser's idle moments and the page going hidden (POD-7161). */
export const platformMemorySignals: MemorySignals = browserMemorySignals()
