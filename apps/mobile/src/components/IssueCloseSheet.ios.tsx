import { Host } from '@expo/ui'
import {
  BottomSheet,
  Button,
  Form,
  Group,
  NavigationStack,
  Section,
  Text,
  Toolbar,
  ToolbarItem,
  VStack,
} from '@expo/ui/swift-ui'
import {
  accessibilityIdentifier,
  disabled,
  font,
  foregroundStyle,
  navigationBarTitleDisplayMode,
  navigationTitle,
  presentationDetents,
  presentationDragIndicator,
} from '@expo/ui/swift-ui/modifiers'
import { LOADING } from '@podium/client-graph/worklist/rollup'
import type { IssueCloseReason } from '@podium/model'
import { useRef, useState } from 'react'
import { StyleSheet } from 'react-native'
import { useIssueCloseConcerns } from '../client/use-issue-close'
import { color } from '../theme/theme'
import {
  closeConfirmLabel,
  closeSubtitle,
  closeTitle,
  type IssueCloseSheetProps,
} from './issue-close-copy'

/** A native confirmation sheet, with the same live concerns as the desktop. */
export function IssueCloseSheet(props: IssueCloseSheetProps) {
  if (props.reason === null) return null
  return (
    <VisibleIssueCloseSheet
      key={`${props.issue.id}:${props.reason}`}
      {...props}
      reason={props.reason}
    />
  )
}

function VisibleIssueCloseSheet({
  issue,
  reason,
  busy = false,
  onConfirm,
  onClose,
}: IssueCloseSheetProps & { reason: IssueCloseReason }) {
  const value = useIssueCloseConcerns(issue.id)
  const pending = value === LOADING
  const concerns = pending ? [] : value
  const [presented, setPresented] = useState(true)
  const confirmed = useRef(false)
  const dismissed = useRef(false)

  return (
    <Host style={styles.host} seedColor={color.accentTint}>
      <BottomSheet
        isPresented={presented}
        onIsPresentedChange={setPresented}
        onDismiss={() => {
          if (dismissed.current) return
          dismissed.current = true
          onClose()
          if (confirmed.current) onConfirm(reason)
        }}
      >
        <Group
          modifiers={[
            presentationDetents(['medium', 'large']),
            presentationDragIndicator('visible'),
            accessibilityIdentifier('issue-close-sheet'),
          ]}
        >
          <NavigationStack>
            <Toolbar
              modifiers={[navigationTitle('Close task'), navigationBarTitleDisplayMode('inline')]}
            >
              <Form>
                <Section
                  title={closeTitle(reason, concerns.length, pending)}
                  footer={
                    concerns.length > 0 ? (
                      <Text>{closeSubtitle(concerns.length, pending)}</Text>
                    ) : undefined
                  }
                >
                  {concerns.length === 0 ? <Text>{closeSubtitle(0, pending)}</Text> : null}
                  {concerns.map((concern) => (
                    <VStack key={concern.key} alignment="leading" spacing={4}>
                      <Text modifiers={[font({ textStyle: 'body' })]}>{concern.label}</Text>
                      <Text
                        modifiers={[
                          font({ textStyle: 'subheadline' }),
                          foregroundStyle({ type: 'hierarchical', style: 'secondary' }),
                        ]}
                      >
                        {concern.detail}
                      </Text>
                    </VStack>
                  ))}
                </Section>
                <Section>
                  {/* biome-ignore lint/a11y/useValidAriaRole: SwiftUI Button uses the native action role. */}
                  <Button
                    label={closeConfirmLabel(reason, concerns.length > 0, busy)}
                    role="destructive"
                    modifiers={[disabled(busy || pending)]}
                    onPress={() => {
                      if (busy || pending || confirmed.current) return
                      confirmed.current = true
                      setPresented(false)
                    }}
                  />
                </Section>
              </Form>
              <Toolbar.Content>
                <ToolbarItem placement="cancellationAction">
                  <Button label="Keep open" onPress={() => setPresented(false)} />
                </ToolbarItem>
              </Toolbar.Content>
            </Toolbar>
          </NavigationStack>
        </Group>
      </BottomSheet>
    </Host>
  )
}

const styles = StyleSheet.create({
  host: { position: 'absolute', width: 0, height: 0 },
})
