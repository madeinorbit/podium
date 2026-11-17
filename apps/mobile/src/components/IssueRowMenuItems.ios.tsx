import { Button, Menu, Toggle } from '@expo/ui/swift-ui'
import { disabled } from '@expo/ui/swift-ui/modifiers'
import { discoveredPlacement, type IssueNavigationModel } from '@podium/client-core/values'
import { observer } from '@podium/client-graph/react'
import { issueStatusMenuEntries, issueStatusValueOf } from '@podium/model'
import { type WorkMenuActionId, type WorkMenuLane, workMenuActionIds } from '../lib/work-menu'
import { workMenuItem } from '../lib/work-row-copy'

/**
 * A task row's long-press acts as native context-menu items: Work's row menu
 * and the flight deck's task rows draw the same list. Status is a native
 * submenu; delete carries the destructive role.
 * Labels and glyphs come from the shared row copy.
 */
export const IssueRowMenuItems = observer(function IssueRowMenuItems({
  issue,
  lane,
  canTuck = false,
  canBringBack = false,
  onAction,
  onStatus,
}: {
  issue: IssueNavigationModel
  lane: WorkMenuLane
  canTuck?: boolean
  canBringBack?: boolean
  onAction: (action: WorkMenuActionId) => void
  onStatus: (value: string) => void
}) {
  const placement = discoveredPlacement(issue)
  const actions = workMenuActionIds(issue, lane, {
    placement: Boolean(placement?.originId),
    canTuck,
    canBringBack: lane === 'live' && canBringBack,
  })
  return (
    <>
      {actions.map((action) => {
        if (action === 'status')
          return (
            <Menu key={action} label="Status" systemImage="circle.dashed">
              {/* Expo's Picker defers initial selection to onAppear, so context-menu
                  extraction can see no selection. Toggle reads isOn from props;
                  SwiftUI draws the native menu checkmark and accessibility state. */}
              {issueStatusMenuEntries().map((entry) => (
                <Toggle
                  key={entry.value}
                  label={entry.label}
                  isOn={entry.value === issueStatusValueOf(issue)}
                  onIsOnChange={(isOn) => {
                    if (isOn) onStatus(entry.value)
                  }}
                />
              ))}
            </Menu>
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
