import type { EditorView } from '@codemirror/view'
import type { FileScope } from '@podium/client-core/viewmodels'
import { ArrowDown, ArrowUp, ArrowUpDown, Eye, Pencil, Save, Search, X } from 'lucide-react'
import { type JSX, useDeferredValue, useId, useMemo, useRef, useState } from 'react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { parseDelimitedDocument } from './delimited-document'
import { canSave } from './editor-save'
import { OpenInBrowserButton } from './OpenInBrowserButton'
import { SourceEditor } from './SourceEditor'
import { tableRenderWindow } from './table-window'
import { useFileDocument } from './useFileDocument'

const VALUE_COLLATOR = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' })

type Mode = 'preview' | 'source'
type Sort = { column: number; direction: 'asc' | 'desc' } | null

/** A read-first table for CSV and TSV fixtures and exports. Source mode remains
 * the editing path, so sorting and filtering never rewrite the file by accident. */
export function TableFilePanel({
  scope,
  path,
  onClose,
}: {
  scope: FileScope
  path: string
  onClose: () => void
}): JSX.Element {
  const doc = useFileDocument(scope, path)
  const saveFeedbackId = useId()
  const [mode, setMode] = useState<Mode>('preview')
  const viewRef = useRef<EditorView | null>(null)
  const handleClose = (): void => {
    if (doc.dirty && !window.confirm('You have unsaved changes. Close anyway?')) return
    onClose()
  }

  return (
    <div className="flex h-full w-full min-w-0 flex-col bg-background">
      <div className="flex-none border-b border-border">
        <div className="flex min-h-10 items-center gap-2 px-3 py-1.5">
          <span
            className="min-w-0 flex-1 truncate font-mono text-xs text-muted-foreground"
            title={path}
          >
            {path}
            {doc.dirty && (
              <>
                <span className="ml-1 text-amber-500" aria-hidden="true">
                  ●
                </span>
                <span className="sr-only"> Unsaved changes</span>
              </>
            )}
          </span>
          <Button
            type="button"
            variant="ghost"
            size="icon-xs"
            onClick={handleClose}
            aria-label="Close"
            title="Close"
          >
            <X size={16} aria-hidden="true" />
          </Button>
        </div>
        <div className="flex min-h-8 items-center gap-1 border-t border-border px-2 py-1">
          <div className="flex items-center gap-0.5 rounded-md border border-border p-0.5">
            <ModeButton
              active={mode === 'preview'}
              onClick={() => setMode('preview')}
              label="Table"
            >
              <Eye size={13} aria-hidden="true" />
            </ModeButton>
            <ModeButton active={mode === 'source'} onClick={() => setMode('source')} label="Source">
              <Pencil size={13} aria-hidden="true" />
            </ModeButton>
          </div>
          <span
            id={saveFeedbackId}
            role={doc.saveFeedback?.kind === 'error' ? 'alert' : 'status'}
            className={`min-w-0 flex-1 truncate text-right text-[10px] ${
              doc.saveFeedback?.kind === 'error' ? 'text-destructive' : 'text-success'
            }`}
            title={doc.saveFeedback?.message}
          >
            {doc.saveFeedback?.message ?? ''}
          </span>
          <OpenInBrowserButton scope={scope} path={path} dirty={doc.dirty} />
          <Button
            type="button"
            variant="ghost"
            size="icon-xs"
            onClick={() => void doc.save()}
            disabled={!canSave({ editable: doc.editable, dirty: doc.dirty, saving: doc.saving })}
            pending={doc.saving}
            pendingLabel={<span className="sr-only">Saving file…</span>}
            aria-label={doc.saving ? 'Saving file…' : 'Save'}
            aria-describedby={saveFeedbackId}
            title="Save (⌘S)"
          >
            <Save size={14} aria-hidden="true" />
          </Button>
        </div>
      </div>

      {doc.status === 'error' ? (
        <div className="p-4 text-sm text-muted-foreground">{doc.message}</div>
      ) : doc.status === 'loading' ? (
        <div className="p-4 text-sm text-muted-foreground/60">Loading…</div>
      ) : mode === 'source' ? (
        <div className="flex min-h-0 flex-1">
          <SourceEditor
            key={`${path}:${doc.reloadNonce}`}
            path={path}
            initialContent={doc.content}
            editable={doc.editable}
            onChange={doc.setContent}
            onSave={() => void doc.save()}
            viewRef={viewRef}
          />
        </div>
      ) : (
        <TablePreview path={path} content={doc.content} />
      )}
    </div>
  )
}

function TablePreview({ path, content }: { path: string; content: string }): JSX.Element {
  const filterId = useId()
  const [query, setQuery] = useState('')
  const [sort, setSort] = useState<Sort>(null)
  const deferredContent = useDeferredValue(content)
  const deferredQuery = useDeferredValue(query.trim().toLocaleLowerCase())
  const table = useMemo(
    () => parseDelimitedDocument(deferredContent, /\.tsv$/i.test(path) ? '\t' : ','),
    [deferredContent, path],
  )
  const filtered = useMemo(() => {
    const indexed = table.rows.map((row, sourceIndex) => ({ row, sourceIndex }))
    const matching = deferredQuery
      ? indexed.filter(({ row }) =>
          row.some((value) => value.toLocaleLowerCase().includes(deferredQuery)),
        )
      : indexed
    if (!sort) return matching
    return matching.sort((a, b) => {
      const order = VALUE_COLLATOR.compare(a.row[sort.column] ?? '', b.row[sort.column] ?? '')
      return (sort.direction === 'asc' ? order : -order) || a.sourceIndex - b.sourceIndex
    })
  }, [deferredQuery, sort, table.rows])
  const window = tableRenderWindow(filtered.length, table.columnCount)
  const visibleHeaders = useMemo(() => {
    const counts = new Map<string, number>()
    return table.headers.slice(0, window.columns).map((header, column) => {
      const occurrence = counts.get(header) ?? 0
      counts.set(header, occurrence + 1)
      return { header, column, key: `${header}\u0000${occurrence}` }
    })
  }, [table.headers, window.columns])
  const visibleRows = filtered.slice(0, window.rows)
  const limited =
    table.truncated || window.rows < filtered.length || window.columns < table.columnCount

  const toggleSort = (column: number): void => {
    setSort((current) => {
      if (!current || current.column !== column) return { column, direction: 'asc' }
      if (current.direction === 'asc') return { column, direction: 'desc' }
      return null
    })
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex flex-none flex-col gap-1 border-b border-border px-3 py-2">
        <label htmlFor={filterId} className="relative min-w-0">
          <Search
            size={13}
            aria-hidden="true"
            className="pointer-events-none absolute top-1/2 left-2 -translate-y-1/2 text-muted-foreground"
          />
          <span className="sr-only">Filter rows</span>
          <Input
            id={filterId}
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Filter rows"
            className="h-7 rounded-md border-border bg-muted/20 pr-7 pl-7 text-xs"
          />
          {query && (
            <button
              type="button"
              onClick={() => setQuery('')}
              aria-label="Clear row filter"
              className="absolute top-1/2 right-1 flex size-6 -translate-y-1/2 items-center justify-center rounded text-muted-foreground hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring"
            >
              <X size={12} aria-hidden="true" />
            </button>
          )}
        </label>
        <span
          className="truncate text-right text-[10px] tabular-nums text-muted-foreground"
          role="status"
        >
          {filtered.length === table.rows.length
            ? `${table.rows.length} rows · ${table.columnCount} columns`
            : `${filtered.length} of ${table.rows.length} rows`}
          {limited && ` · showing ${window.rows} rows × ${window.columns} columns`}
          {table.truncated && ' · preview capped for performance'}
        </span>
      </div>
      {table.headers.length === 0 ? (
        <div className="p-4 text-sm text-muted-foreground">This table is empty.</div>
      ) : (
        <div className="min-h-0 flex-1 overflow-auto" data-testid="table-file-viewer">
          <table className="min-w-full border-separate border-spacing-0 font-mono text-[11px]">
            <thead className="sticky top-0 z-10 bg-background">
              <tr>
                <th className="w-px border-r border-b border-border bg-muted/40 px-2 py-1.5 text-right font-medium text-muted-foreground">
                  #
                </th>
                {visibleHeaders.map(({ header, column, key }) => {
                  const active = sort?.column === column
                  const SortIcon = active
                    ? sort.direction === 'asc'
                      ? ArrowUp
                      : ArrowDown
                    : ArrowUpDown
                  return (
                    <th
                      key={key}
                      scope="col"
                      aria-sort={
                        active ? (sort.direction === 'asc' ? 'ascending' : 'descending') : 'none'
                      }
                      className="min-w-28 max-w-80 border-r border-b border-border bg-muted/40 p-0 text-left font-semibold text-foreground last:border-r-0"
                    >
                      <button
                        type="button"
                        onClick={() => toggleSort(column)}
                        className="flex w-full items-center gap-2 px-2 py-1.5 hover:bg-muted/60 focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring"
                        title={`Sort by ${header}`}
                      >
                        <span className="min-w-0 flex-1 truncate">{header}</span>
                        <SortIcon
                          size={11}
                          aria-hidden="true"
                          className={active ? 'text-foreground' : 'text-muted-foreground/50'}
                        />
                      </button>
                    </th>
                  )
                })}
              </tr>
            </thead>
            <tbody>
              {visibleRows.map(({ row, sourceIndex }, rowIndex) => (
                <tr key={sourceIndex} className="odd:bg-muted/10 hover:bg-muted/30">
                  <th
                    scope="row"
                    className="border-r border-b border-border px-2 py-1 text-right font-normal tabular-nums text-muted-foreground select-none"
                  >
                    {rowIndex + 1}
                  </th>
                  {visibleHeaders.map(({ column, key }) => {
                    const value = row[column] ?? ''
                    return (
                      <td
                        key={key}
                        className="max-w-80 min-w-28 truncate border-r border-b border-border px-2 py-1 text-foreground last:border-r-0"
                        title={value}
                      >
                        {value || (
                          <>
                            <span className="sr-only">Empty cell</span>
                            <span aria-hidden="true"> </span>
                          </>
                        )}
                      </td>
                    )
                  })}
                </tr>
              ))}
            </tbody>
          </table>
          {filtered.length === 0 && (
            <div className="p-4 text-center text-xs text-muted-foreground">
              No rows match "{query.trim()}".
            </div>
          )}
        </div>
      )}
    </div>
  )
}

function ModeButton({
  active,
  onClick,
  label,
  children,
}: {
  active: boolean
  onClick: () => void
  label: string
  children: JSX.Element
}): JSX.Element {
  return (
    <button
      data-pressable
      type="button"
      onClick={onClick}
      title={label}
      aria-label={label}
      aria-pressed={active}
      className={`flex h-6 w-6 items-center justify-center rounded focus-visible:outline-2 focus-visible:outline-ring ${
        active ? 'bg-muted text-foreground' : 'text-muted-foreground hover:text-foreground'
      }`}
    >
      {children}
    </button>
  )
}
