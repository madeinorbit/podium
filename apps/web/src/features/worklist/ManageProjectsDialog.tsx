import { shallowEqual } from '@podium/client-core/store'
import { worklistSlice } from '@podium/client-core/viewmodels'
import { ArrowDown, ArrowUp, SlidersHorizontal } from 'lucide-react'
import type { JSX } from 'react'
import { useState } from 'react'
import { useSlice, useStoreSelector } from '@/app/store'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog'

/** A deliberate edit mode for project order; the busy worklist stays untouched. */
export function ManageProjectsButton(): JSX.Element {
  const { projects } = useSlice(worklistSlice)
  const { setSidebarSettings } = useStoreSelector(
    (state) => ({ setSidebarSettings: state.setSidebarSettings }),
    shallowEqual,
  )
  const [open, setOpen] = useState(false)
  const [draft, setDraft] = useState<string[]>([])
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [announcement, setAnnouncement] = useState('')

  const visible = [
    ...draft
      .map((key) => projects.find((project) => project.key === key))
      .filter((project) => project !== undefined),
    ...projects.filter((project) => !draft.includes(project.key)),
  ]
  const changed = visible.some((project, index) => project.key !== projects[index]?.key)

  const move = (index: number, direction: -1 | 1): void => {
    const keys = visible.map((project) => project.key)
    const next = index + direction
    if (next < 0 || next >= keys.length) return
    ;[keys[index], keys[next]] = [keys[next] as string, keys[index] as string]
    setDraft(keys)
    setAnnouncement(`${visible[index]?.name ?? 'Project'} moved to position ${next + 1}`)
  }

  const save = async (): Promise<void> => {
    setSaving(true)
    setError(null)
    try {
      await setSidebarSettings({
        repoSort: 'custom',
        repoOrder: visible.map((project) => project.key),
      })
      setOpen(false)
    } catch {
      setError('Could not save project order. Try again.')
    } finally {
      setSaving(false)
    }
  }

  return (
    <>
      <button
        data-pressable
        type="button"
        data-testid="manage-projects"
        title="Manage projects"
        aria-label="Manage projects"
        onClick={() => {
          setDraft(projects.map((project) => project.key))
          setError(null)
          setAnnouncement('')
          setOpen(true)
        }}
        className="flex size-8 flex-none items-center justify-center rounded-[7px] border border-input bg-chip text-muted-foreground transition-colors hover:bg-accent hover:text-text-strong focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
      >
        <SlidersHorizontal size={14} aria-hidden="true" />
      </button>
      <Dialog open={open} onOpenChange={(next) => !saving && setOpen(next)}>
        <DialogContent className="flex max-h-[min(680px,calc(100dvh-32px))] flex-col gap-0 overflow-hidden p-0 sm:max-w-[480px]">
          <div className="border-b border-border px-5 py-4">
            <DialogTitle className="text-base font-semibold">Manage projects</DialogTitle>
            <DialogDescription className="mt-1 text-sm text-muted-foreground">
              Set their order in the sidebar. New projects appear at the end.
            </DialogDescription>
          </div>
          <ol className="min-h-0 flex-1 overflow-y-auto overscroll-contain p-3">
            {visible.map((project, index) => (
              <li
                key={project.key}
                className="flex min-h-12 items-center gap-3 rounded-md px-2 py-1.5 odd:bg-muted/40"
              >
                <span className="w-5 flex-none text-center font-mono text-xs text-text-dim">
                  {index + 1}
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm font-medium text-foreground">
                    {project.name}
                  </span>
                  <span className="block truncate font-mono text-[11px] text-muted-foreground">
                    {project.aliases.find((alias) => alias.startsWith('/')) ?? project.key}
                  </span>
                </span>
                <Button
                  type="button"
                  size="icon"
                  variant="ghost"
                  className="focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
                  aria-label={`Move ${project.name} up`}
                  title={`Move ${project.name} up`}
                  disabled={index === 0}
                  onClick={() => move(index, -1)}
                >
                  <ArrowUp size={16} aria-hidden="true" />
                </Button>
                <Button
                  type="button"
                  size="icon"
                  variant="ghost"
                  className="focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
                  aria-label={`Move ${project.name} down`}
                  title={`Move ${project.name} down`}
                  disabled={index === visible.length - 1}
                  onClick={() => move(index, 1)}
                >
                  <ArrowDown size={16} aria-hidden="true" />
                </Button>
              </li>
            ))}
            {visible.length === 0 && (
              <li className="px-3 py-8 text-center text-sm text-muted-foreground">
                Add a repository to start a project list.
              </li>
            )}
          </ol>
          <p role="status" className="sr-only">
            {announcement}
          </p>
          {error && (
            <p role="alert" className="px-5 pb-2 text-sm text-destructive">
              {error}
            </p>
          )}
          <div className="flex justify-end gap-2 border-t border-border px-5 py-3">
            <Button
              type="button"
              variant="secondary"
              onClick={() => setOpen(false)}
              disabled={saving}
            >
              Cancel
            </Button>
            <Button type="button" onClick={() => void save()} disabled={!changed || saving}>
              {saving ? 'Saving...' : 'Save order'}
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </>
  )
}
