import { relativeTime } from '@podium/client-core/focus'
import { useSlice } from '@podium/client-core/react'
import {
  lastUsedMaps,
  machineViewsFromWire,
  panelLabel,
  type RepoNavView,
  resolveSpawnTargetMachine,
  spawnTargetForRepo,
  usableMachines,
  worklistSlice,
} from '@podium/client-core/viewmodels'
import type { AgentKind, MachineId } from '@podium/model'
import { machinesWithRepo } from '@podium/model'
import { usePathname, useRouter } from 'expo-router'
import { ChevronLeft, ChevronRight, GitBranch, Plus, Settings2 } from 'lucide-react-native'
import { useMemo, useState } from 'react'
import { StyleSheet, Text, View } from 'react-native'
import { useMobileStore, useSessions } from '../client/hooks'
import { sessionHref } from '../lib/session-route'
import { alpha } from '../theme/mix'
import { color, font, leading, mono, monoLabel, radius, sans, space } from '../theme/theme'
import { BottomSheet } from './BottomSheet'
import { Icon } from './Icon'
import { PressableScale } from './PressableScale'
import { HeaderButton } from './Screen'
import { kindTone } from './spine'

const HARNESSES: { kind: AgentKind; label: string }[] = [
  { kind: 'claude-code', label: 'Claude Code' },
  { kind: 'codex', label: 'Codex' },
  { kind: 'grok', label: 'Grok' },
  { kind: 'opencode', label: 'OpenCode' },
  { kind: 'cursor', label: 'Cursor' },
  { kind: 'shell', label: 'Shell' },
]

type PickerStep = 'harness' | 'repo' | 'machine' | null

/**
 * The pocket equivalent of desktop's New Agent dropdown. Every quick launch goes
 * through `store.spawnDraftAgent`, so the session is born inside a durable draft
 * issue and receives the same issue-prime lifecycle as the desk.
 *
 * WHY THIS IS NOT AN ACTION LIST [POD-724]. It was one — nine centred labels in
 * a stack, with "New task", six harness names and "Session options…" all at the
 * same weight and the same size, so the one choice that decides where the work
 * LANDS (tracked task with a branch and worktree, versus a bare session in a
 * draft vessel) looked exactly like the choice of which CLI to run. This sheet
 * says the two things in two languages: the task is a card with its consequence
 * written on it, and the harnesses are a tile grid wearing the same per-kind
 * marks the flight deck's session bands already use — so picking one is
 * recognition rather than reading.
 */
export function NewWorkButton() {
  const pathname = usePathname()
  const router = useRouter()
  const store = useMobileStore()
  const sessions = useSessions()
  const { sections } = useSlice(worklistSlice)
  const [step, setStep] = useState<PickerStep>(null)
  const [harness, setHarness] = useState<AgentKind>('claude-code')
  const [repoPath, setRepoPath] = useState<string | null>(null)

  // Machines as THIS principal may act on them (doc §3.1.4 M1/M5): `see` is
  // already applied by the server's per-principal projection, `use` is read per
  // LIST by the shared helper — the identical reading the desktop spawn row,
  // the automations form and the execution-profile picker use. Two spellings of
  // "may I run here" is exactly how one surface comes to offer a machine
  // another refuses.
  const machineViews = useMemo(() => machineViewsFromWire(store.machines), [store.machines])

  const { repos, lastUsedByRepo } = useMemo(() => {
    const choices = [...sections.pinnedRepos, ...sections.repos]
    const { byRepo } = lastUsedMaps(sections, sessions)
    return {
      repos: choices.sort(
        (a, b) =>
          (byRepo.get(b.path) ?? 0) - (byRepo.get(a.path) ?? 0) ||
          a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }),
      ),
      lastUsedByRepo: byRepo,
    }
  }, [sections, sessions])

  const selectedRepo = repos.find((repo) => repo.path === repoPath)

  /**
   * Where this spawn lands, or `null` to refuse it outright — the same shape
   * the desktop spawn row uses.
   *
   * DENIED IS NOT NO TARGET (§3.1.4 M5). An `unauthorized` refusal must STOP
   * the spawn: falling through to the repo's primary checkout is the silently
   * retargeted placement M5 forbids. `no-repo` and `unreachable` both resolve to
   * `undefined`, which `spawnTargetForRepo` turns into the repo's own main
   * checkout exactly as before — that split is what keeps single-user parity
   * while closing the hole.
   */
  const resolveSpawnMachine = (
    repo: RepoNavView,
    machineId?: MachineId,
  ): MachineId | undefined | null => {
    if (machineId !== undefined)
      return usableMachines(machineViews).some((m) => m.id === machineId) ? machineId : null
    const { machineId: resolved, refusal } = resolveSpawnTargetMachine(repo, sessions, machineViews)
    return refusal === 'unauthorized' ? null : resolved
  }

  /** The machines that hold this repo, as views — the population the two
   *  refusals are distinguished within. */
  const machineChoices = (repo: RepoNavView) => {
    const withRepo = new Set(
      machinesWithRepo(
        repo,
        machineViews.map((v) => v.machine),
      ).map((m) => m.id),
    )
    return machineViews.filter((v) => withRepo.has(v.machine.id))
  }

  const close = () => setStep(null)

  const start = (repo: RepoNavView, machineId?: MachineId) => {
    const targetMachine = resolveSpawnMachine(repo, machineId)
    if (targetMachine === null) return
    const { worktree } = spawnTargetForRepo(repo, targetMachine)
    const { sessionId } = store.spawnDraftAgent({ target: worktree, agentKind: harness })
    close()
    router.push(sessionHref(sessionId, pathname))
  }

  const title =
    step === 'repo'
      ? `New ${panelLabel(harness)}`
      : step === 'machine' && selectedRepo
        ? selectedRepo.name
        : 'New work'
  const caption =
    step === 'repo'
      ? 'Choose a repository'
      : step === 'machine'
        ? 'Choose a machine'
        : 'Track it as a task, or put an agent on it now'

  return (
    <>
      <HeaderButton label="New work" onPress={() => setStep('harness')}>
        <Icon as={Plus} size={19} color={color.text} />
      </HeaderButton>
      <BottomSheet
        visible={step !== null}
        onClose={close}
        mode="fit"
        scrollable={step !== 'harness'}
        contentStyle={styles.content}
        head={
          <View style={styles.head}>
            {step !== 'harness' ? (
              <PressableScale
                accessibilityRole="button"
                accessibilityLabel="Back"
                onPress={() => setStep(step === 'machine' ? 'repo' : 'harness')}
                style={({ pressed }) => [styles.headBack, pressed && styles.pressed]}
              >
                <Icon as={ChevronLeft} size={16} color={color.textDim} />
              </PressableScale>
            ) : null}
            <View style={styles.headText}>
              <Text style={styles.headTitle} numberOfLines={1}>
                {title}
              </Text>
              <Text style={styles.headCaption} numberOfLines={1}>
                {caption}
              </Text>
            </View>
          </View>
        }
      >
        {step === 'harness' ? (
          <>
            {/* The one choice that changes where the work LIVES gets a card of
                its own, with its consequence written on it. */}
            <PressableScale
              accessibilityRole="button"
              accessibilityLabel="New task"
              accessibilityHint="Tracked work with its own branch and worktree"
              onPress={() => {
                close()
                router.push('/new-issue')
              }}
              scaleTo={0.985}
              style={({ pressed }) => [styles.taskCard, pressed && styles.taskCardPressed]}
            >
              <View style={styles.taskIcon}>
                <Icon as={GitBranch} size={17} color={color.accentTint} />
              </View>
              <View style={styles.taskText}>
                <Text style={styles.taskTitle}>New task</Text>
                <Text style={styles.taskSub}>Tracked work, with its own branch and worktree</Text>
              </View>
              <Icon as={ChevronRight} size={16} color={alpha(color.accentTint, 0.75)} />
            </PressableScale>

            <Text style={styles.groupLabel}>START AN AGENT</Text>
            <View style={styles.grid}>
              {HARNESSES.map(({ kind, label }) => {
                const t = kindTone(kind)
                return (
                  <PressableScale
                    key={kind}
                    accessibilityRole="button"
                    accessibilityLabel={label}
                    onPress={() => {
                      setHarness(kind)
                      setStep('repo')
                    }}
                    scaleTo={0.95}
                    style={({ pressed }) => [styles.tile, pressed && styles.tilePressed]}
                  >
                    <View style={[styles.tileMark, { backgroundColor: t.bg }]}>
                      <Text style={[styles.tileCh, { color: t.fg }]}>{t.ch}</Text>
                    </View>
                    <Text style={styles.tileLabel} numberOfLines={1}>
                      {label}
                    </Text>
                  </PressableScale>
                )
              })}
            </View>

            <PressableScale
              accessibilityRole="button"
              accessibilityLabel="Session options"
              accessibilityHint="Title, first prompt, or a custom working directory"
              onPress={() => {
                close()
                router.push(`/new-session?backTo=${encodeURIComponent(pathname)}`)
              }}
              style={({ pressed }) => [styles.quiet, pressed && styles.pressed]}
            >
              <Icon as={Settings2} size={15} color={color.textFaint} />
              <Text style={styles.quietText}>Session options…</Text>
              <Icon as={ChevronRight} size={14} color={color.textMicro} />
            </PressableScale>
          </>
        ) : null}

        {step === 'repo' ? (
          repos.length === 0 ? (
            <Text style={styles.none}>No repositories are available on this account.</Text>
          ) : (
            <View style={styles.list}>
              {repos.map((repo, i) => {
                const used = lastUsedByRepo.get(repo.path)
                return (
                  <PressableScale
                    key={repo.path}
                    accessibilityRole="button"
                    accessibilityLabel={repo.name}
                    onPress={() => {
                      if (machineChoices(repo).length <= 1) {
                        start(repo)
                        return
                      }
                      setRepoPath(repo.path)
                      setStep('machine')
                    }}
                    scaleTo={0.99}
                    style={({ pressed }) => [
                      styles.row,
                      i > 0 && styles.rowDivider,
                      pressed && styles.rowPressed,
                    ]}
                  >
                    <View style={styles.repoTile}>
                      <Text style={styles.repoInitial}>{(repo.name[0] ?? '?').toUpperCase()}</Text>
                    </View>
                    <View style={styles.rowText}>
                      <Text style={styles.rowTitle} numberOfLines={1}>
                        {repo.name}
                      </Text>
                      <Text style={styles.rowSub} numberOfLines={1}>
                        {used
                          ? `last used ${relativeTime(new Date(used).toISOString(), Date.now())}`
                          : 'not used yet'}
                      </Text>
                    </View>
                    <Icon as={ChevronRight} size={15} color={color.textMicro} />
                  </PressableScale>
                )
              })}
            </View>
          )
        ) : null}

        {step === 'machine' && selectedRepo ? (
          <View style={styles.list}>
            {/* UNAUTHORIZED AND UNREACHABLE ARE DIFFERENT WORDS (§3.1.4 M5).
                Both produce a machine you cannot spawn on, and collapsing them
                makes a person wait for a wake-up that will never help. Neither
                is pressable — the picker must not OFFER a machine the principal
                lacks `use` on — but the denied one says so rather than
                vanishing. */}
            {machineChoices(selectedRepo).map((view, i) => {
              const ok = view.availability === 'available'
              return (
                <PressableScale
                  key={view.machine.id}
                  accessibilityRole="button"
                  accessibilityLabel={view.machine.name}
                  accessibilityState={{ disabled: !ok }}
                  disabled={!ok}
                  scaleTo={0.99}
                  onPress={() => start(selectedRepo, view.machine.id)}
                  style={({ pressed }) => [
                    styles.row,
                    i > 0 && styles.rowDivider,
                    !ok && styles.rowDisabled,
                    pressed && styles.rowPressed,
                  ]}
                >
                  <View
                    style={[styles.dot, { backgroundColor: ok ? color.success : color.textMicro }]}
                  />
                  <View style={styles.rowText}>
                    <Text style={styles.rowTitle} numberOfLines={1}>
                      {view.machine.name}
                    </Text>
                    {ok ? null : (
                      <Text style={styles.rowSub}>
                        {view.availability === 'unauthorized' ? 'No access' : 'Offline'}
                      </Text>
                    )}
                  </View>
                  {ok ? <Icon as={ChevronRight} size={15} color={color.textMicro} /> : null}
                </PressableScale>
              )
            })}
          </View>
        ) : null}
      </BottomSheet>
    </>
  )
}

const styles = StyleSheet.create({
  head: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.sm,
    paddingHorizontal: space.lg,
    paddingBottom: space.md,
  },
  headBack: {
    width: 28,
    height: 28,
    borderRadius: radius.md,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: color.surface,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: color.border,
  },
  headText: {
    flex: 1,
    minWidth: 0,
    gap: 1,
  },
  headTitle: {
    ...sans(600),
    color: color.text,
    fontSize: font.heading,
    letterSpacing: -0.35,
  },
  headCaption: {
    ...sans(400),
    color: color.textFaint,
    fontSize: font.tiny,
  },
  content: {
    paddingHorizontal: space.lg,
    paddingBottom: space.sm,
  },

  taskCard: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.md,
    padding: space.md,
    borderRadius: radius.lg,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: color.accentBorder,
    backgroundColor: color.accentSoft,
  },
  taskCardPressed: {
    backgroundColor: 'rgba(245, 197, 24, 0.2)',
  },
  taskIcon: {
    width: 34,
    height: 34,
    borderRadius: radius.md,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: color.bgSunken,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: color.accentBorder,
  },
  taskText: {
    flex: 1,
    minWidth: 0,
    gap: 2,
  },
  taskTitle: {
    ...sans(600),
    color: color.text,
    fontSize: font.small,
  },
  taskSub: {
    ...sans(400),
    color: color.accentTint,
    fontSize: font.tiny,
    lineHeight: leading(font.tiny),
  },

  groupLabel: {
    ...monoLabel(),
    color: color.label,
    marginTop: space.lg,
    marginBottom: space.sm,
  },
  grid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: space.sm,
  },
  tile: {
    flexBasis: '30%',
    flexGrow: 1,
    alignItems: 'center',
    gap: 7,
    paddingVertical: space.md,
    paddingHorizontal: space.sm,
    borderRadius: radius.lg,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: color.border,
    backgroundColor: color.surface,
  },
  tilePressed: {
    backgroundColor: color.surfacePressed,
    borderColor: color.borderStrong,
  },
  tileMark: {
    width: 30,
    height: 30,
    borderRadius: radius.md,
    alignItems: 'center',
    justifyContent: 'center',
  },
  tileCh: {
    ...mono(600),
    fontSize: font.tiny,
  },
  tileLabel: {
    ...sans(500),
    color: color.body,
    fontSize: font.micro,
  },

  quiet: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.sm,
    marginTop: space.md,
    minHeight: 44,
    paddingHorizontal: space.sm,
    borderRadius: radius.md,
  },
  quietText: {
    ...sans(400),
    flex: 1,
    color: color.textDim,
    fontSize: font.tiny,
  },

  list: {
    borderRadius: radius.lg,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: color.border,
    backgroundColor: color.surface,
    overflow: 'hidden',
  },
  row: {
    minHeight: 56,
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.md,
    paddingHorizontal: space.md,
    paddingVertical: 9,
  },
  rowDivider: {
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: alpha(color.hairline, 0.8),
  },
  rowPressed: {
    backgroundColor: color.surfacePressed,
  },
  rowDisabled: {
    opacity: 0.42,
  },
  rowText: {
    flex: 1,
    minWidth: 0,
    gap: 1,
  },
  rowTitle: {
    ...sans(500),
    color: color.text,
    fontSize: font.small,
  },
  rowSub: {
    ...mono(400),
    color: color.textFaint,
    fontSize: font.micro,
  },
  repoTile: {
    width: 30,
    height: 30,
    borderRadius: radius.md,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: color.elevated,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: color.border,
  },
  repoInitial: {
    ...mono(600),
    color: color.textDim,
    fontSize: font.tiny,
  },
  dot: {
    width: 8,
    height: 8,
    borderRadius: 4,
    marginLeft: 4,
  },
  none: {
    ...sans(400),
    color: color.textFaint,
    fontSize: font.small,
    paddingVertical: space.lg,
    textAlign: 'center',
  },
  pressed: {
    opacity: 0.65,
  },
})
