import type { IssueViewModel } from '@podium/client-core/replica'
import { spawnIssueAgent } from '@podium/client-core/values'
import { issueDisplayRef } from '@podium/protocol'
import { observer } from 'mobx-react-lite'
import { useMemo, useState } from 'react'
import { ScrollView, StyleSheet, Text, View } from 'react-native'
import { useTrpc } from '../client/hooks'
import { useSettingsRecord } from '../client/use-settings-record'
import { IssueLaunchForm } from '../lib/issue-launch-draft'
import { type LaunchPlan, launchPlanCanSubmit } from '../lib/launch-configuration'
import { color } from '../theme/theme'
import { FormSheetHeader } from './compose/FormSheetHeader'
import { insetRow } from './InsetGroup'
import { LaunchConfigurationFields } from './LaunchConfigurationFields'

/**
 * Start an agent on an existing task: the contents of the `launch/[issueId]`
 * form sheet. UIKit presents it over the chat or task page, so what it was
 * opened from stays visible under the sheet's own dimming.
 */
export function ConfiguredIssueLaunchSheet(
  props: Parameters<typeof ConfiguredIssueLaunchSheetBody>[0],
) {
  return <ConfiguredIssueLaunchSheetBody key={props.issue?.id ?? 'closed'} {...props} />
}

const ConfiguredIssueLaunchSheetBody = observer(function ConfiguredIssueLaunchSheetBody({
  issue,
  onStarted,
  onClose,
  topInset = 0,
}: {
  issue: IssueViewModel | null
  onStarted?: () => void
  onClose: () => void
  /** The transparent native bar's height. Fit-to-contents measures this view,
   * so the inset must be part of it, not a scroll view's adjusted inset:
   * rows pushed below the measured height draw but take no touches. */
  topInset?: number
}) {
  const trpc = useTrpc()
  const settingsRequest = useSettingsRecord()
  const form = useMemo(
    () =>
      issue
        ? new IssueLaunchForm(
            issue,
            (patch) => trpc.issues.update.mutate({ id: issue.id, patch }),
            () => settingsRequest?.model?.codingHarness,
          )
        : null,
    [issue, trpc, settingsRequest],
  )
  const [plan, setPlan] = useState<LaunchPlan | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const start = async () => {
    if (!issue || !form || !launchPlanCanSubmit(plan) || busy) return
    setBusy(true)
    setError(null)
    try {
      form.patch(plan.configuration)
      await form.edits.submit()
      await spawnIssueAgent(trpc.issues, { id: issue.id })
      onClose()
      onStarted?.()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
      setBusy(false)
    }
  }

  return (
    <View collapsable={false} style={styles.sheet}>
      <FormSheetHeader
        title="Start Agent"
        confirmLabel="Start"
        confirmAccessibilityLabel="Start agent"
        busyLabel="Starting…"
        canConfirm={launchPlanCanSubmit(plan)}
        busy={busy}
        onCancel={onClose}
        onConfirm={() => void start()}
      />
      <ScrollView
        style={styles.scroll}
        contentContainerStyle={[styles.body, { paddingTop: topInset + 8 }]}
        contentInsetAdjustmentBehavior="never"
        alwaysBounceVertical={false}
      >
        {issue && form ? (
          <LaunchConfigurationFields
            header={`${issueDisplayRef(issue)} · ${issue.title}`}
            repoPath={issue.repoPath}
            value={form.configuration}
            onChange={(next) => {
              form.patch(next)
            }}
            onPlan={setPlan}
          />
        ) : null}
        {error ? (
          <Text accessibilityLiveRegion="assertive" style={insetRow.footerError}>
            {error}
          </Text>
        ) : null}
      </ScrollView>
    </View>
  )
})

const styles = StyleSheet.create({
  sheet: { backgroundColor: color.groupedBg },
  scroll: { flexGrow: 0 },
  body: { paddingHorizontal: 16, paddingBottom: 8 },
})
