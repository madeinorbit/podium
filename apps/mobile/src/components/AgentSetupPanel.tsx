import type {
  AgentSetupDetail,
  AgentSetupItem,
  AgentSetupView,
} from '@podium/client-graph/agent-setup-view'
import type { HarnessInstallAction } from '@podium/protocol'
import { observer } from 'mobx-react-lite'
import { type ReactNode, useEffect, useState } from 'react'
import { ActivityIndicator, StyleSheet, Switch, Text, View } from 'react-native'
import {
  adaptiveColor,
  appearancePalette,
  color,
  font,
  leading,
  radius,
  sans,
  space,
} from '../theme/theme'
import { HarnessChip } from './AgentMark'
import { BottomSheet } from './BottomSheet'
import { PressableScale } from './PressableScale'

/** Presentation shared by the connected phone sheet and its visual harness. */
export const AgentSetupPanel = observer(function AgentSetupPanel({
  view,
  onClose,
  loginTerminal,
  onCloseLogin,
}: {
  view: AgentSetupView
  onClose: () => void
  loginTerminal?: ReactNode
  onCloseLogin?: () => void
}) {
  const [closing, setClosing] = useState(false)
  const dismiss = () => setClosing(true)
  return (
    <BottomSheet
      visible={!closing}
      onClose={onClose}
      mode="detented"
      accessibilityLabel="Set up agents"
      testID="agent-setup-sheet"
      contentStyle={styles.content}
      virtualizedContent={
        loginTerminal ? () => <View style={{ flex: 1 }}>{loginTerminal}</View> : undefined
      }
      head={
        <View style={styles.header}>
          {view.detail && !loginTerminal ? (
            <PressableScale
              accessibilityRole="button"
              accessibilityLabel="Back to agents"
              style={styles.headerAction}
              onPress={() => {
                view.detail?.cancelRemove()
                view.detail?.cancelRemoveHome()
                view.closeDetail()
              }}
            >
              <Text style={styles.link}>‹ Back</Text>
            </PressableScale>
          ) : null}
          <View style={styles.headerTitle}>
            <Text accessibilityRole="header" style={styles.title}>
              {loginTerminal
                ? 'Finish agent sign-in'
                : (view.detail?.item.label ?? 'Set up agents')}
            </Text>
            <Text style={styles.caption} numberOfLines={1}>
              {view.machineName}
            </Text>
          </View>
          <PressableScale
            accessibilityRole="button"
            accessibilityLabel="Done"
            onPress={loginTerminal ? onCloseLogin : dismiss}
            style={styles.headerAction}
          >
            <Text style={styles.done}>Done</Text>
          </PressableScale>
        </View>
      }
      footer={
        loginTerminal ||
        (view.selectedKinds.length === 0 && view.primary.kind === 'done') ? undefined : (
          <AgentSetupFooter view={view} onClose={dismiss} />
        )
      }
    >
      {!view.reachable ? (
        <Text style={styles.notice}>
          This machine is offline or unavailable. Setup resumes when it is available.
        </Text>
      ) : null}
      {view.checking ? (
        <View style={styles.checking} accessibilityLiveRegion="polite">
          <ActivityIndicator color={color.working} />
          <Text style={styles.body}>Checking agents…</Text>
        </View>
      ) : view.detail ? (
        <HarnessPage key={view.detail.item.kind} detail={view.detail} />
      ) : (
        <>
          {view.groups.map((group) => (
            <Group key={group.status} title={group.title}>
              {group.items.map((item) => (
                <SetupRow key={item.kind} item={item} />
              ))}
            </Group>
          ))}
          <Text style={styles.note}>
            Podium installs its own copy when you ask. Your own install stays yours.
          </Text>
        </>
      )}
    </BottomSheet>
  )
})

const AgentSetupFooter = observer(function AgentSetupFooter({
  view,
  onClose,
}: {
  view: AgentSetupView
  onClose: () => void
}) {
  if (view.selectedKinds.length > 0) {
    const label =
      view.selectedKinds.length === 1
        ? `Install ${view.itemFor(view.selectedKinds[0]!)?.label ?? 'agent'}`
        : `Install ${view.selectedKinds.length} agents`
    return (
      <Primary
        label={label}
        disabled={!view.canInstallSelected}
        onPress={() => view.installSelected()}
      />
    )
  }
  if (view.primary.kind === 'start') {
    return (
      <Primary
        label={view.primary.label}
        disabled={!view.primary.enabled || !view.reachable}
        onPress={() => {
          view.start()
          onClose()
        }}
      />
    )
  }
  return null
})

const SetupRow = observer(function SetupRow({ item }: { item: AgentSetupItem }) {
  const content = (
    <>
      <HarnessChip kind={item.kind} size={32} />
      <View style={styles.rowText}>
        <Text style={styles.rowTitle}>{item.label}</Text>
        <Text style={[styles.caption, item.failure ? styles.error : undefined]}>
          {item.progressLabel ??
            item.failure ??
            item.blocked?.reason ??
            [item.version, item.sourceLabel, item.usable ? item.signIn.stateLabel : undefined]
              .filter(Boolean)
              .join(' · ')}
        </Text>
        {item.installing ? <InstallProgress item={item} /> : null}
        {item.blocked?.fix ? <Text style={styles.caption}>{item.blocked.fix}</Text> : null}
      </View>
    </>
  )
  if (item.selectable) {
    return (
      <PressableScale
        accessibilityRole="checkbox"
        accessibilityLabel={`Install ${item.label}`}
        accessibilityState={{ checked: item.selected, disabled: !item.canInstall }}
        aria-checked={item.selected}
        disabled={!item.canInstall}
        onPress={() => item.view.toggle(item.kind)}
        style={styles.row}
      >
        {content}
        <View style={[styles.tick, item.selected && styles.tickSelected]}>
          {item.selected ? <Text style={styles.tickMark}>✓</Text> : null}
        </View>
      </PressableScale>
    )
  }
  if (item.status === 'failed' || (item.installing && item.canCancel)) {
    const retry = item.status === 'failed'
    return (
      <View style={styles.row}>
        {content}
        <PressableScale
          accessibilityRole="button"
          accessibilityLabel={`${retry ? 'Try again' : 'Cancel install'} ${item.label}`}
          disabled={retry && !item.canInstall}
          onPress={() => (retry ? item.retry() : item.cancel())}
          style={styles.rowAction}
        >
          <Text style={styles.link}>{retry ? 'Try again' : 'Cancel'}</Text>
        </PressableScale>
      </View>
    )
  }
  return (
    <PressableScale
      accessibilityRole="button"
      accessibilityLabel={`${item.label}, ${item.status === 'needs-sign-in' ? 'needs sign-in' : item.status === 'ready' ? 'ready' : (item.progressLabel ?? 'details')}`}
      onPress={() => {
        item.view.setFocus(item.kind)
        item.view.openDetail(item.kind)
      }}
      style={styles.row}
    >
      {content}
      <Text style={styles.chevron}>›</Text>
    </PressableScale>
  )
})

const InstallProgress = observer(function InstallProgress({ item }: { item: AgentSetupItem }) {
  const progress = item.progress
  const reportedPercent = progress?.percent
  // This is the fill's visual position for this mounted install, not a second
  // machine fact. A vendor can start another file at zero; keep the fill from
  // jumping backwards, and keep it in place during verification and setup.
  const [furthestPercent, setFurthestPercent] = useState(reportedPercent)
  useEffect(() => {
    if (reportedPercent !== undefined)
      setFurthestPercent((previous) => Math.max(previous ?? 0, reportedPercent))
  }, [reportedPercent])
  const percent =
    reportedPercent === undefined
      ? furthestPercent
      : Math.max(furthestPercent ?? 0, reportedPercent)
  const label =
    progress?.phase === 'verify'
      ? 'Checking download…'
      : progress?.phase === 'setup'
        ? 'Finishing setup…'
        : progress
          ? `Downloading${reportedPercent === undefined ? '' : ` ${reportedPercent}%`}…`
          : (item.progressLabel ?? 'Installing…')
  return (
    <View>
      {progress ? <Text style={styles.caption}>{label}</Text> : null}
      <View style={styles.progressRow}>
        <View
          accessibilityRole="progressbar"
          accessibilityLabel={label}
          aria-valuemin={percent === undefined ? undefined : 0}
          aria-valuemax={percent === undefined ? undefined : 100}
          aria-valuenow={percent}
          aria-valuetext={label}
          accessibilityValue={
            percent === undefined
              ? { text: label }
              : { min: 0, max: 100, now: percent, text: label }
          }
          style={styles.progress}
        >
          <View
            style={[
              styles.progressFill,
              { width: percent === undefined ? '35%' : `${Math.max(0, Math.min(100, percent))}%` },
            ]}
          />
        </View>
        {reportedPercent === undefined ? (
          <ActivityIndicator
            size="small"
            color={color.working}
            accessible={false}
            accessibilityElementsHidden
            aria-hidden
            importantForAccessibility="no-hide-descendants"
          />
        ) : null}
      </View>
    </View>
  )
})

const HarnessPage = observer(function HarnessPage({ detail }: { detail: AgentSetupDetail }) {
  const [showSignIn, setShowSignIn] = useState(false)
  if (detail.confirmingRemove)
    return (
      <Confirmation
        message={detail.removeConfirmation}
        label="Remove Podium’s copy"
        onConfirm={() => detail.confirmRemove()}
        onCancel={() => detail.cancelRemove()}
      />
    )
  if (detail.confirmingRemoveHome && detail.removeHomeConfirmation)
    return (
      <Confirmation
        message={detail.removeHomeConfirmation}
        label="Delete Podium home"
        onConfirm={() => detail.confirmRemoveHome()}
        onCancel={() => detail.cancelRemoveHome()}
      />
    )
  return (
    <>
      <Group title="">
        <Fact
          label="Podium’s copy"
          value={detail.podiumVersion ?? detail.podiumLabel ?? 'Not installed'}
        />
        <Fact
          label="Your install"
          value={detail.ownVersion ?? detail.ownLabel ?? 'Not installed'}
        />
        <PressableScale
          accessibilityRole="button"
          accessibilityLabel="Sign-in options"
          onPress={() => setShowSignIn(!showSignIn)}
          style={styles.fact}
        >
          <Text style={styles.rowTitle}>Sign-in</Text>
          <Text style={[styles.caption, styles.factValue]}>{detail.item.signIn.stateLabel}</Text>
        </PressableScale>
      </Group>
      {detail.item.installing ? (
        <View style={styles.notice}>
          <Text style={styles.body}>{detail.item.progressLabel}</Text>
          <InstallProgress item={detail.item} />
          {detail.item.canCancel ? (
            <ActionRow label="Cancel install" onPress={() => detail.item.cancel()} />
          ) : null}
        </View>
      ) : null}
      {[detail.sharingWarning, detail.ledgerNotice, detail.installReason, detail.updateNotice]
        .filter(Boolean)
        .map((note) => (
          <Text key={note} style={styles.notice}>
            {note}
          </Text>
        ))}
      {detail.item.prerequisites.map((block) => (
        <Text key={block.reason} style={styles.notice}>
          {block.reason} {block.fix}
        </Text>
      ))}
      {detail.item.usable && (showSignIn || detail.item.status === 'needs-sign-in') ? (
        <SignInChoices item={detail.item} />
      ) : null}
      {detail.sections.map((section) => (
        <Group
          key={section.key}
          title={section.key === 'home' || section.key === 'remove' ? '' : section.title}
        >
          {[...section.actions]
            .sort((a, b) => (UPDATE_ORDER[a] ?? 10) - (UPDATE_ORDER[b] ?? 10))
            .map((next) =>
              next === 'pause' || next === 'resume' ? (
                <View key={next} style={[styles.row, styles.actionRow]}>
                  <Text style={[styles.rowTitle, styles.rowText]}>Pause updates</Text>
                  <Switch
                    accessibilityLabel="Pause updates"
                    hitSlop={8}
                    style={styles.pauseSwitch}
                    value={detail.autoUpdate === false}
                    disabled={detail.disabled(next)}
                    onValueChange={() => detail.press(next)}
                    trackColor={{ false: color.tertiaryFill, true: color.accent }}
                  />
                </View>
              ) : (
                <DetailAction key={next} detail={detail} action={next} />
              ),
            )}
        </Group>
      ))}
      {detail.vendorUpdated ? (
        <Text style={styles.note}>The agent’s own updater manages this copy.</Text>
      ) : null}
      {detail.lastCheckAt ? (
        <Text style={styles.note}>
          Last checked {new Date(detail.lastCheckAt).toLocaleString()}
        </Text>
      ) : null}
      {detail.waiting ? (
        <View style={styles.checking}>
          <ActivityIndicator color={color.working} />
          <Text style={styles.caption}>Waiting for the machine…</Text>
        </View>
      ) : null}
      {detail.error || detail.lastError ? (
        <Text accessibilityRole="alert" style={[styles.notice, styles.error]}>
          {detail.error ?? detail.lastError}
        </Text>
      ) : null}
      {detail.pendingSessionsNote ? (
        <Text style={styles.notice}>{detail.pendingSessionsNote}</Text>
      ) : null}
      {detail.changes ? (
        <Group title="Podium’s changes">
          {detail.changes.length === 0 ? (
            <Text style={styles.notice}>No Podium changes recorded.</Text>
          ) : (
            detail.changes.map((change) => (
              <View key={change.id} style={styles.change}>
                <Text style={styles.body}>{change.file}</Text>
                <Text style={styles.caption}>
                  {change.edit.kind === 'owned-file'
                    ? 'File created by Podium'
                    : change.edit.kind === 'hook-handlers'
                      ? `Podium’s hooks for ${change.edit.events.length} events`
                      : `${change.edit.path.join('.')} = ${JSON.stringify(change.edit.value)}`}
                </Text>
                {change.status ? (
                  <Text style={styles.caption}>
                    {change.status === 'changed'
                      ? 'Kept: you changed this after Podium wrote it.'
                      : change.status === 'restored'
                        ? 'Restored.'
                        : (change.reason ?? 'Could not restore.')}
                  </Text>
                ) : null}
              </View>
            ))
          )}
        </Group>
      ) : null}
      {detail.home ? (
        <Group title="In the Podium home">
          <Text style={styles.notice}>
            {detail.home.exists
              ? detail.home.conversations.length
                ? 'Conversations in this home:'
                : 'No conversations in this home.'
              : 'There is no Podium home.'}
          </Text>
          {detail.home.conversations.map((conversation) => (
            <Text key={conversation.id} style={styles.notice}>
              {conversation.title}
            </Text>
          ))}
        </Group>
      ) : null}
    </>
  )
})

function DetailAction({
  detail,
  action,
}: {
  detail: AgentSetupDetail
  action: HarnessInstallAction
}) {
  const labels: Partial<Record<HarnessInstallAction, string>> = {
    check: 'Check for updates',
    'take-settings': 'Copy my settings into Podium’s',
    'remove-changes': 'Undo Podium’s changes',
    remove: 'Remove Podium’s copy',
  }
  return (
    <ActionRow
      label={labels[action] ?? detail.label(action)}
      disabled={detail.disabled(action)}
      destructive={action === 'remove' || action === 'remove-home'}
      onPress={() => detail.press(action)}
    />
  )
}

const SignInChoices = observer(function SignInChoices({ item }: { item: AgentSetupItem }) {
  const [saved, setSaved] = useState(false)
  const signIn = item.signIn
  return (
    <Group title="Sign-in">
      {signIn.choices.map((choice) => (
        <ActionRow
          key={choice.kind}
          label={choice.title}
          detail={choice.detail}
          disabled={!choice.available || signIn.opening || signIn.savingCredential !== null}
          onPress={() => {
            if (choice.kind === 'browser') void signIn.signInWithBrowser()
            else if (choice.kind === 'saved') setSaved(!saved)
            else signIn.chooseLater()
          }}
        />
      ))}
      {saved
        ? signIn.savedCredentials.map((credential) => (
            <ActionRow
              key={credential.id}
              label={credential.label}
              detail={credential.hint}
              onPress={() => {
                setSaved(false)
                void signIn.useSavedCredential(credential.id)
              }}
            />
          ))
        : null}
      {signIn.error ? (
        <Text accessibilityRole="alert" style={[styles.notice, styles.error]}>
          {signIn.error}
        </Text>
      ) : null}
    </Group>
  )
})

function Confirmation({
  message,
  label,
  onConfirm,
  onCancel,
}: {
  message: string
  label: string
  onConfirm: () => void
  onCancel: () => void
}) {
  return (
    <Group title="Confirm removal">
      <Text accessibilityRole="alert" style={styles.notice}>
        {message}
      </Text>
      <ActionRow label={label} destructive onPress={onConfirm} />
      <ActionRow label="Cancel" onPress={onCancel} />
    </Group>
  )
}
function Group({ title, children }: { title: string; children: ReactNode }) {
  return (
    <View style={styles.section}>
      {title ? (
        <Text accessibilityRole="header" style={styles.groupTitle}>
          {title}
        </Text>
      ) : null}
      <View style={styles.group}>{children}</View>
    </View>
  )
}
function Fact({ label, value }: { label: string; value: string }) {
  return (
    <View style={styles.fact}>
      <Text style={styles.rowTitle}>{label}</Text>
      <Text style={[styles.caption, styles.factValue]}>{value}</Text>
    </View>
  )
}
function ActionRow({
  label,
  detail,
  onPress,
  disabled,
  destructive,
}: {
  label: string
  detail?: string
  onPress: () => void
  disabled?: boolean
  destructive?: boolean
}) {
  return (
    <PressableScale
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ disabled }}
      disabled={disabled}
      onPress={onPress}
      style={[styles.row, styles.actionRow, disabled && styles.disabled]}
    >
      <View style={styles.rowText}>
        <Text style={[styles.body, destructive ? styles.error : styles.link]}>{label}</Text>
        {detail ? <Text style={styles.caption}>{detail}</Text> : null}
      </View>
    </PressableScale>
  )
}
function Primary({
  label,
  disabled,
  onPress,
}: {
  label: string
  disabled?: boolean
  onPress: () => void
}) {
  return (
    <PressableScale
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ disabled }}
      disabled={disabled}
      onPress={onPress}
      style={[styles.primary, disabled && styles.disabled]}
    >
      <Text style={styles.primaryText}>{label}</Text>
    </PressableScale>
  )
}

const UPDATE_ORDER: Partial<Record<HarnessInstallAction, number>> = {
  check: 0,
  pause: 1,
  resume: 1,
  back: 2,
}
const groupBackground = adaptiveColor(
  appearancePalette.light.surface,
  appearancePalette.dark.surface,
  appearancePalette.light.surface,
  appearancePalette.dark.surface,
)
const styles = StyleSheet.create({
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.sm,
    paddingHorizontal: space.lg,
    paddingBottom: space.md,
    backgroundColor: color.bgSunken,
  },
  headerTitle: { flex: 1, gap: 2 },
  headerAction: { minHeight: 44, minWidth: 44, alignItems: 'center', justifyContent: 'center' },
  title: { ...sans(600), color: color.text, fontSize: font.heading },
  done: { ...sans(600), color: color.accentTint, fontSize: font.body },
  content: {
    paddingHorizontal: space.lg,
    paddingTop: space.sm,
    paddingBottom: space.xl,
    backgroundColor: color.bgSunken,
  },
  intro: {
    ...sans(),
    color: color.textDim,
    fontSize: font.small,
    lineHeight: leading(font.small),
    marginBottom: space.lg,
  },
  section: { marginBottom: space.lg + space.xs, gap: space.sm },
  groupTitle: {
    ...sans(),
    color: color.textDim,
    fontSize: font.tiny,
    paddingHorizontal: space.md,
    textTransform: 'uppercase',
  },
  group: {
    backgroundColor: groupBackground,
    borderRadius: radius.xl,
    overflow: 'hidden',
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: color.border,
  },
  row: {
    minHeight: 56,
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.md,
    paddingHorizontal: space.md,
    paddingVertical: space.sm,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: color.hairline,
  },
  actionRow: { minHeight: 44 },
  pauseSwitch: { height: 31, width: 51 },
  rowText: { flex: 1, minWidth: 0, gap: 3 },
  rowTitle: { ...sans(500), color: color.text, fontSize: font.body },
  body: { ...sans(), color: color.body, fontSize: font.body, lineHeight: leading(font.body) },
  caption: { ...sans(), color: color.textDim, fontSize: font.tiny, lineHeight: leading(font.tiny) },
  rowAction: { minHeight: 44, minWidth: 44, justifyContent: 'center', alignItems: 'center' },
  link: { ...sans(), color: color.accentTint, fontSize: font.body },
  chevron: { color: color.textMicro, fontSize: font.title },
  tick: {
    width: 24,
    height: 24,
    borderRadius: radius.full,
    borderWidth: 1.5,
    borderColor: color.borderStrong,
    alignItems: 'center',
    justifyContent: 'center',
  },
  tickSelected: { backgroundColor: color.accent, borderColor: color.accent },
  tickMark: { ...sans(600), color: color.onAccent, fontSize: font.small },
  primary: {
    minHeight: 50,
    margin: space.lg,
    borderRadius: radius.xl,
    backgroundColor: color.accent,
    alignItems: 'center',
    justifyContent: 'center',
  },
  primaryText: { ...sans(600), color: color.onAccent, fontSize: font.body },
  disabled: { opacity: 0.4 },
  note: {
    ...sans(),
    color: color.textDim,
    fontSize: font.tiny,
    lineHeight: leading(font.tiny),
    marginBottom: space.lg,
  },
  notice: {
    ...sans(),
    color: color.body,
    fontSize: font.small,
    lineHeight: leading(font.small),
    padding: space.md,
  },
  error: { color: color.dangerText },
  checking: { padding: space.lg, flexDirection: 'row', alignItems: 'center', gap: space.md },
  fact: {
    minHeight: 48,
    padding: space.md,
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    gap: space.md,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: color.hairline,
  },
  factValue: { flex: 1, textAlign: 'right' },
  change: { padding: space.md, gap: space.xs },
  progressRow: { flexDirection: 'row', alignItems: 'center', gap: space.sm },
  progress: {
    flex: 1,
    height: 4,
    backgroundColor: color.workingSoft,
    borderRadius: radius.full,
    marginTop: space.sm,
    marginBottom: space.xs,
    overflow: 'hidden',
  },
  progressFill: { height: 4, backgroundColor: color.working, borderRadius: radius.full },
})
