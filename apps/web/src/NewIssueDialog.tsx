import type { JSX } from 'react'
import { useState } from 'react'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Textarea } from '@/components/ui/textarea'
import { useIsMobile } from '@/hooks/use-is-mobile'
import { useStore } from './store'

/** A Linear search hit. Not exported from the protocol — the server returns this
 *  shape from `issues.linearSearch`, so we mirror it inline. */
interface LinearHit {
  identifier: string
  title: string
  url: string
}

/** The repo basename, falling back to the full path — repos are shown by name. */
function repoLabel(path: string): string {
  return path.split('/').filter(Boolean).pop() ?? path
}

export function NewIssueDialog({ onClose }: { onClose: () => void }): JSX.Element {
  const { trpc, repos } = useStore()
  const isMobile = useIsMobile()
  const [title, setTitle] = useState('')
  const [description, setDescription] = useState('')
  const [repoPath, setRepoPath] = useState(repos[0]?.path ?? '')
  const [parentBranch, setParentBranch] = useState('')
  // '' = use the configured default agent (no flag).
  const [agent, setAgent] = useState('')
  const [startNow, setStartNow] = useState(true)
  const [linear, setLinear] = useState<{ identifier: string; url: string } | undefined>()
  const [query, setQuery] = useState('')
  const [results, setResults] = useState<LinearHit[]>([])
  const [searching, setSearching] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  const searchLinear = async () => {
    const q = query.trim()
    if (!q) return
    setSearching(true)
    setError('')
    try {
      setResults(await trpc.issues.linearSearch.query({ query: q }))
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setSearching(false)
    }
  }

  const importHit = (hit: LinearHit) => {
    setTitle(hit.title)
    setLinear({ identifier: hit.identifier, url: hit.url })
    if (!description.trim()) setDescription(`From ${hit.identifier}: ${hit.url}`)
  }

  const submit = async () => {
    setBusy(true)
    setError('')
    try {
      await trpc.issues.create.mutate({
        repoPath,
        title: title.trim(),
        description: description.trim() || undefined,
        parentBranch: parentBranch.trim() || undefined,
        defaultAgent: agent || undefined,
        startNow,
        linear,
      })
      onClose()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
      setBusy(false)
    }
  }

  return (
    <Dialog
      open
      modal={isMobile ? 'trap-focus' : true}
      onOpenChange={(o) => {
        if (!o) onClose()
      }}
    >
      <DialogContent className="flex max-h-[min(720px,calc(100dvh-2rem))] w-full max-w-md flex-col gap-3 overflow-y-auto">
        <DialogHeader>
          <DialogTitle>New Issue</DialogTitle>
        </DialogHeader>

        <div className="flex flex-col gap-3">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="issue-title">Title</Label>
            <Input
              id="issue-title"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="What needs doing?"
            />
          </div>

          <div className="flex flex-col gap-1.5">
            <Label htmlFor="issue-desc">Description</Label>
            <Textarea
              id="issue-desc"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="Context, acceptance criteria…"
            />
          </div>

          <details className="rounded-lg border border-border px-3 py-2 text-[13px]">
            <summary className="cursor-pointer select-none text-foreground">
              Import from Linear
            </summary>
            <div className="mt-2 flex flex-col gap-2">
              <div className="flex gap-2">
                <Input
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') {
                      e.preventDefault()
                      void searchLinear()
                    }
                  }}
                  placeholder="Search Linear issues…"
                />
                <Button
                  type="button"
                  variant="secondary"
                  size="sm"
                  disabled={searching || !query.trim()}
                  onClick={() => void searchLinear()}
                >
                  {searching ? 'Searching…' : 'Search'}
                </Button>
              </div>
              {results.length > 0 && (
                <ul className="flex flex-col gap-1">
                  {results.map((r) => (
                    <li key={r.identifier}>
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        className="h-auto w-full justify-start whitespace-normal px-2 py-1.5 text-left font-normal"
                        onClick={() => importHit(r)}
                      >
                        <span className="font-mono text-muted-foreground">{r.identifier}</span>{' '}
                        {r.title}
                      </Button>
                    </li>
                  ))}
                </ul>
              )}
              {linear && (
                <p className="text-[12px] text-muted-foreground">Linked to {linear.identifier}</p>
              )}
            </div>
          </details>

          <div className="flex flex-col gap-1.5">
            <Label>Repo</Label>
            <Select value={repoPath} onValueChange={(v) => setRepoPath(v ?? '')}>
              <SelectTrigger className="w-full">
                <SelectValue placeholder="Select a repo" />
              </SelectTrigger>
              <SelectContent>
                {repos.map((r) => (
                  <SelectItem key={r.path} value={r.path}>
                    {repoLabel(r.path)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="flex flex-col gap-1.5">
            <Label htmlFor="issue-parent">Parent branch</Label>
            <Input
              id="issue-parent"
              value={parentBranch}
              onChange={(e) => setParentBranch(e.target.value)}
              placeholder="main"
            />
          </div>

          <div className="flex flex-col gap-1.5">
            <Label>Agent</Label>
            <Select value={agent} onValueChange={(v) => setAgent(v ?? '')}>
              <SelectTrigger className="w-full">
                <SelectValue placeholder="Default" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="">Default</SelectItem>
                <SelectItem value="claude-code">Claude Code</SelectItem>
                <SelectItem value="codex">Codex</SelectItem>
                <SelectItem value="grok">Grok</SelectItem>
              </SelectContent>
            </Select>
          </div>

          <Label className="cursor-pointer">
            <Checkbox checked={startNow} onCheckedChange={(c) => setStartNow(c === true)} />
            Start work now
          </Label>

          {error && <p className="text-[12px] text-destructive">{error}</p>}
        </div>

        <DialogFooter>
          <Button type="button" variant="outline" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button
            type="button"
            disabled={!title.trim() || !repoPath || busy}
            onClick={() => void submit()}
          >
            {busy ? 'Creating…' : 'Create'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
