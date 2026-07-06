import type { IssueWire } from '@podium/protocol'
import { FileText } from 'lucide-react'
import type { JSX } from 'react'
import { useMemo } from 'react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { artifactKind, basename, issueForCwd, subissuesWithPanels, worktreeAssetUrl } from './dock-panel'
import { STAGE_LABELS } from './issue-card'
import { useStore } from './store'

function Hint({ children }: { children: string }): JSX.Element {
  return <div className="px-1 py-0.5 text-xs text-muted-foreground/70">{children}</div>
}

function SectionTitle({ children }: { children: string }): JSX.Element {
  return (
    <div className="px-1 pt-3 pb-1 text-[11px] font-semibold tracking-[0.08em] text-muted-foreground uppercase">
      {children}
    </div>
  )
}

/** The three panel sections (Todo / Artifacts / Deferred) for one issue. */
function PanelSections({ issue, machineId }: { issue: IssueWire; machineId?: string }): JSX.Element {
  const { trpc, httpOrigin, openFileInWorktree } = useStore()
  const panel = issue.panel
  const todos = panel?.todos ?? []
  const artifacts = panel?.artifacts ?? []
  const deferred = panel?.deferred ?? []
  const doneCount = todos.filter((t) => t.done).length
  const root = issue.worktreePath

  const toggleTodo = (index1: number, done: boolean) => {
    void trpc.issues.panelApply
      .mutate({ id: issue.id, op: done ? 'todo-done' : 'todo-undone', index: index1 })
      .catch(() => {})
  }

  return (
    <div>
      <SectionTitle>Todo</SectionTitle>
      {todos.length === 0 ? (
        <Hint>No todos published.</Hint>
      ) : (
        <>
          <div className="px-1 pb-1 text-xs text-muted-foreground">
            {doneCount}/{todos.length} done
          </div>
          <div className="flex flex-col gap-0.5">
            {todos.map((t, i) => (
              <label
                // biome-ignore lint/suspicious/noArrayIndexKey: todos are positional (1-based index API)
                key={i}
                className="flex cursor-pointer items-start gap-2 rounded-md px-1 py-1 text-[13px] hover:bg-accent/50"
              >
                <Checkbox
                  checked={t.done}
                  onCheckedChange={(checked) => toggleTodo(i + 1, checked === true)}
                  className="mt-0.5"
                />
                <span className={t.done ? 'text-muted-foreground line-through' : 'text-foreground'}>
                  {t.text}
                </span>
              </label>
            ))}
          </div>
        </>
      )}

      <SectionTitle>Artifacts</SectionTitle>
      {artifacts.length === 0 ? (
        <Hint>No artifacts published.</Hint>
      ) : (
        <div className="flex flex-col gap-2">
          {artifacts.map((a) => {
            const kind = artifactKind(a.path)
            const label = a.title ?? basename(a.path)
            if (root && kind === 'image') {
              return (
                <figure key={a.path} className="px-1">
                  <img
                    src={worktreeAssetUrl({ httpOrigin, root, path: a.path, machineId })}
                    alt={label}
                    className="max-w-full rounded-md border border-border"
                  />
                  <figcaption className="mt-0.5 text-xs text-muted-foreground">{label}</figcaption>
                </figure>
              )
            }
            if (root && kind === 'video') {
              return (
                <figure key={a.path} className="px-1">
                  {/* biome-ignore lint/a11y/useMediaCaption: agent-published artifact videos have no captions */}
                  <video
                    src={worktreeAssetUrl({ httpOrigin, root, path: a.path, machineId })}
                    controls
                    className="max-w-full rounded-md border border-border"
                  />
                  <figcaption className="mt-0.5 text-xs text-muted-foreground">{label}</figcaption>
                </figure>
              )
            }
            return (
              <Button
                key={a.path}
                variant="ghost"
                size="sm"
                className="h-auto w-full justify-start gap-2 px-1 py-1 text-left font-normal"
                disabled={!root}
                onClick={() => {
                  // Artifact paths may be worktree-relative; file tabs need absolute.
                  if (root)
                    openFileInWorktree({
                      machineId,
                      root,
                      path: a.path.startsWith('/') ? a.path : `${root}/${a.path}`,
                    })
                }}
              >
                <FileText size={14} className="flex-none" />
                <span className="min-w-0 overflow-hidden text-ellipsis whitespace-nowrap text-[13px]">
                  {label}
                </span>
              </Button>
            )
          })}
        </div>
      )}

      <SectionTitle>Deferred</SectionTitle>
      {deferred.length === 0 ? (
        <Hint>Nothing deferred.</Hint>
      ) : (
        <div className="flex flex-col gap-1">
          {deferred.map((d) => (
            <div key={`${d.addedAt}:${d.text}`} className="px-1 text-[13px] text-muted-foreground">
              {d.text}
              <span className="ml-2 text-xs text-muted-foreground/60">
                {new Date(d.addedAt).toLocaleDateString()}
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

/** Issue tab of the right dock: the agent-published panel (todos, artifacts,
 *  deferrals) for the issue owning the active worktree, plus subissue panels. */
export function IssuePanelView({ cwd, machineId }: { cwd: string; machineId?: string }): JSX.Element {
  const { issues } = useStore()
  const issue = useMemo(() => issueForCwd(issues, cwd), [issues, cwd])
  const subs = useMemo(
    () => (issue ? subissuesWithPanels(issues, issue.id) : []),
    [issues, issue],
  )

  if (!issue) {
    return (
      <div className="p-3 text-xs text-muted-foreground/70">
        No issue owns this worktree.
      </div>
    )
  }

  return (
    <div className="min-h-0 flex-1 overflow-y-auto p-3">
      <div className="flex items-center gap-2">
        <span className="min-w-0 flex-1 overflow-hidden text-ellipsis whitespace-nowrap text-[13px] font-medium">
          #{issue.seq} {issue.title}
        </span>
        <Badge variant="secondary">{STAGE_LABELS[issue.stage]}</Badge>
      </div>
      <PanelSections issue={issue} machineId={machineId} />
      {subs.map((sub) => (
        <div key={sub.id} className="mt-4 border-t border-border pt-3">
          <div className="flex items-center gap-2">
            <span className="min-w-0 flex-1 overflow-hidden text-ellipsis whitespace-nowrap text-[13px] font-medium">
              #{sub.seq} {sub.title}
            </span>
            <Badge variant="secondary">{STAGE_LABELS[sub.stage]}</Badge>
          </div>
          <PanelSections issue={sub} machineId={machineId} />
        </div>
      ))}
    </div>
  )
}
