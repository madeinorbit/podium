import { Button, Picker, Text } from '@expo/ui/swift-ui'
import { disabled, pickerStyle, tag } from '@expo/ui/swift-ui/modifiers'
import { discoveredPlacement, type IssueNavigationModel } from '@podium/client-core/values'
import { observer } from '@podium/client-graph/react'
import { issueStatusMenuEntries, issueStatusValueOf } from '@podium/model'
import { type WorkMenuActionId, type WorkMenuLane, workMenuActionIds } from '../lib/work-menu'
import { workMenuItem } from '../lib/work-row-copy'

/**
 * A task row's long-press acts as native context-menu items: Work's row menu
 * and the flight deck's task rows draw the same list. Status is a picker
 * submenu; delete carries the destructive role.
 * Labels and glyphs come from the shared row copy.
 */
export const IssueRowMenuItems = observer(function IssueRowMenuItems({
  issue,
  lane,
  canBringBack = true,
  onAction,
  onStatus,
}: {
  issue: IssueNavigationModel
  lane: WorkMenuLane
  canBringBack?: boolean
  onAction: (action: WorkMenuActionId) => void
  onStatus: (value: string) => void
}) {
  const placement = discoveredPlacement(issue)
  const actions = workMenuActionIds(issue, lane, { placement: Boolean(placement?.originId) })
  return (
    <>
      {actions.map((action) => {
        if (action === 'status')
          return (
            <Picker
              key={action}
              label="Status"
              systemImage="circle.dashed"
              selection={issueStatusValueOf(issue)}
              onSelectionChange={(value) => onStatus(String(value))}
              modifiers={[pickerStyle('menu')]}
            >
              {issueStatusMenuEntries().map((entry) => (
                <Text key={entry.value} modifiers={[tag(entry.value)]}>
                  {entry.label}
                </Text>
              ))}
            </Picker>
          )
        const { label, symbol } = workMenuItem(action, {
          unread: Boolean(issue.unread),
          inMission: placement?.placement === 'mission',
        })
        return (
          <Button
            key={action}
            label={label}
            systemImage={symbol}
            role={action === 'delete' ? 'destructive' : 'default'}
            onPress={() => onAction(action)}
            modifiers={action === 'bringBack' ? [disabled(!canBringBack)] : []}
          />
        )
      })}
    </>
  )
})
