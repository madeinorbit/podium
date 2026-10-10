import type { MessageLedger } from '@podium/client-graph/message-ledger'
import { useEffect } from 'react'
import { usePanelVisible } from '@/app/panel-visible'

/** Warm deck panels can stay mounted while hidden; polling needs both signals. */
export function useLedgerVisibility(ledger: MessageLedger | null): void {
  const panelVisible = usePanelVisible()
  useEffect(() => {
    if (!ledger) return
    const visible = () => ledger.setVisible(panelVisible && document.visibilityState !== 'hidden')
    visible()
    document.addEventListener('visibilitychange', visible)
    return () => { document.removeEventListener('visibilitychange', visible); ledger.setVisible(false) }
  }, [ledger, panelVisible])
}
