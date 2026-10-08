import { panelLabel } from '@podium/client-core/values'
import { observer } from 'mobx-react-lite'
import { usePoolHeaderSession } from '@/app/header-data'

/** The load and memory panels share the label rule and read only this session. */
export const HeaderSessionLabel = observer(function HeaderSessionLabel({ id }: { id: string }) {
  const header = usePoolHeaderSession(id)
  return <>{header ? `${panelLabel(header.agentKind)} — ${header.title}` : id.slice(0, 8)}</>
})
