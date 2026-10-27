import { observer } from 'mobx-react-lite'
import { Switch } from '@/components/ui/switch'
import { type AccountTipLogContract, useAccountTipLog } from '@/features/tips/account-tip-log'
import { Row } from './shared'

export const ShowTipsRow = observer(function ShowTipsRow({ log }: { log: AccountTipLogContract }) {
  return (
    <Row
      label="Show tips"
      description="First Flights explains Podium as you go. Saved to your account; turning tips on keeps your progress."
    >
      <Switch
        aria-label="Show tips"
        checked={log.enabled}
        disabled={!log.ready}
        onCheckedChange={(on) => log.setEnabled(on)}
      />
    </Row>
  )
})

export function AccountTipsRow() {
  return <ShowTipsRow log={useAccountTipLog()} />
}
