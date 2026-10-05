import { createTerminalReferences, type TerminalReferences } from '@podium/client-graph/terminal-references'
import { useEffect, useState } from 'react'
import { useMobilePool } from './mobile-pool'

export function useTerminalReferences(active: boolean) {
  const pool = useMobilePool()
  const [reader, setReader] = useState<TerminalReferences | null>(null)
  useEffect(() => {
    const next = pool ? createTerminalReferences(pool) : null
    setReader(next)
    return () => next?.dispose()
  }, [pool])
  useEffect(() => { reader?.setActive(active) }, [reader, active])
  return reader
}
