import { observer } from 'mobx-react-lite'
import { toast } from 'sonner'
import { Switch } from '@/components/ui/switch'
import { type AccountTipLogContract, useAccountTipLog } from '@/features/tips/account-tip-log'
import { Row } from './shared'

export const ShowTipsRow = observer(function ShowTipsRow({ log }: { log: AccountTipLogContract }) {
  return (
    <Row
      label="Show tips"
      description="Short explanations as you use Podium. Turning them back on also brings back hints you dismissed."
    >
      <Switch
        aria-label="Show tips"
        checked={log.enabled}
        disabled={!log.ready}
        onCheckedChange={(on) => {
          const previous = log.enabled
          const undo = log.setEnabled(on)
          toast('Saved', {
            action: { label: 'Undo', onClick: undo ?? (() => log.setEnabled(previous)) },
          })
        }}
      />
    </Row>
  )
})

export function AccountTipsRow() {
  return <ShowTipsRow log={useAccountTipLog()} />
}
