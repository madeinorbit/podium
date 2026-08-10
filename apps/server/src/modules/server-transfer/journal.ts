import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeSync,
} from 'node:fs'
import { join } from 'node:path'
import {
  SERVER_TRANSFER_FORMAT_VERSION,
  type TransferJournalEntry,
  type TransferJournalState,
  type TransferRecord,
} from './types'

export const LEGAL_TRANSITIONS = [
  ['preparing', 'staged'],
  ['staged', 'validated'],
  ['validated', 'source-fenced'],
  ['source-fenced', 'committing'],
  ['committing', 'committed'],
  ['committing', 'commit-uncertain'],
  ['commit-uncertain', 'committed'],
  ['preparing', 'aborted'],
  ['staged', 'aborted'],
  ['validated', 'aborted'],
  ['source-fenced', 'aborted'],
] as const satisfies ReadonlyArray<readonly [TransferJournalState, TransferJournalState]>

export const canTransition = (from: TransferJournalState, to: TransferJournalState): boolean =>
  from === to || LEGAL_TRANSITIONS.some(([left, right]) => left === from && right === to)

export const isActiveTransfer = (state: TransferJournalState): boolean =>
  state === 'preparing' ||
  state === 'staged' ||
  state === 'validated' ||
  state === 'source-fenced' ||
  state === 'committing'

export const blocksWritableServer = (state: TransferJournalState): boolean =>
  state === 'source-fenced' ||
  state === 'committing' ||
  state === 'commit-uncertain' ||
  state === 'committed'

export const safelyRecoverableBeforeFence = (state: TransferJournalState): boolean =>
  state === 'preparing' || state === 'staged' || state === 'validated'

function fsyncDirectory(dir: string): void {
  const handle = openSync(dir, 'r')
  try {
    fsyncSync(handle)
  } finally {
    closeSync(handle)
  }
}

function writeAtomic(dir: string, value: TransferJournalEntry): void {
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  const temporary = join(dir, `journal.json.tmp-${process.pid}-${Date.now()}`)
  let renamed = false
  try {
    const handle = openSync(temporary, 'wx', 0o600)
    try {
      const bytes = Buffer.from(`${JSON.stringify(value)}\n`)
      let offset = 0
      while (offset < bytes.length) offset += writeSync(handle, bytes, offset)
      fsyncSync(handle)
    } finally {
      closeSync(handle)
    }
    renameSync(temporary, join(dir, 'journal.json'))
    renamed = true
    fsyncDirectory(dir)
  } finally {
    if (!renamed && existsSync(temporary)) unlinkSync(temporary)
  }
}

function parsedEntry(raw: string): TransferJournalEntry {
  const value: unknown = JSON.parse(raw)
  if (typeof value !== 'object' || value === null)
    throw new Error('transfer journal is not an object')
  const candidate = value as Partial<TransferJournalEntry>
  if (
    candidate.formatVersion !== SERVER_TRANSFER_FORMAT_VERSION ||
    typeof candidate.state !== 'string' ||
    typeof candidate.record !== 'object' ||
    candidate.record === null ||
    typeof candidate.record.transferId !== 'string' ||
    typeof candidate.createdAt !== 'string' ||
    typeof candidate.updatedAt !== 'string'
  ) {
    throw new Error('transfer journal has an unsupported version or invalid shape')
  }
  return candidate as TransferJournalEntry
}

export class TransferJournal {
  readonly path: string

  constructor(
    private readonly dir: string,
    private readonly now: () => Date = () => new Date(),
  ) {
    this.path = join(dir, 'journal.json')
  }

  read(): TransferJournalEntry | undefined {
    if (!existsSync(this.path)) return undefined
    const raw = readFileSync(this.path, 'utf8')
    if (raw.trim().length === 0) throw new Error('transfer journal is empty')
    return parsedEntry(raw)
  }

  begin(record: TransferRecord): TransferJournalEntry {
    const current = this.read()
    if (current && current.state !== 'aborted') {
      throw new Error(`cannot begin transfer while journal is ${current.state}`)
    }
    const timestamp = this.now().toISOString()
    const entry: TransferJournalEntry = {
      formatVersion: SERVER_TRANSFER_FORMAT_VERSION,
      state: 'preparing',
      record,
      createdAt: timestamp,
      updatedAt: timestamp,
    }
    writeAtomic(this.dir, entry)
    return entry
  }

  updateRecord(record: TransferRecord): TransferJournalEntry {
    const current = this.required()
    const next = {
      ...current,
      record,
      updatedAt: this.now().toISOString(),
    }
    writeAtomic(this.dir, next)
    return next
  }

  transition(state: TransferJournalState): TransferJournalEntry {
    const current = this.required()
    if (current.state === state) return current
    if (!canTransition(current.state, state)) {
      throw new Error(`illegal transfer journal transition: ${current.state} -> ${state}`)
    }
    const next = {
      ...current,
      state,
      updatedAt: this.now().toISOString(),
    }
    writeAtomic(this.dir, next)
    return next
  }

  abort(
    error: { code: string; message: string },
    cleanup: { result: 'cleaned' | 'pending'; detail?: string },
  ): TransferJournalEntry {
    const current = this.required()
    if (current.state === 'aborted') return current
    if (!canTransition(current.state, 'aborted')) {
      throw new Error(`cannot abort transfer from ${current.state}`)
    }
    const next = {
      ...current,
      state: 'aborted' as const,
      error,
      record: { ...current.record, phase: 'aborted' as const },
      cleanup,
      updatedAt: this.now().toISOString(),
    }
    writeAtomic(this.dir, next)
    return next
  }

  commit(record: TransferRecord, cleanup?: { result: 'cleaned' | 'pending'; detail?: string }): TransferJournalEntry {
    const current = this.required()
    if (current.state === 'committed') return current
    if (current.state !== 'committing') {
      throw new Error('cannot commit transfer from ' + current.state)
    }
    const next = {
      ...current,
      state: 'committed' as const,
      record: { ...record, phase: 'switching' as const, targetProof: true, sourceConnected: false },
      ...(cleanup ? { cleanup } : {}),
      updatedAt: this.now().toISOString(),
    }
    writeAtomic(this.dir, next)
    return next
  }

  commitUncertain(error: { code: string; message: string }): TransferJournalEntry {
    const current = this.required()
    if (current.state === 'commit-uncertain') return current
    if (current.state !== 'committing') {
      throw new Error(`cannot mark transfer uncertain from ${current.state}`)
    }
    const next = {
      ...current,
      state: 'commit-uncertain' as const,
      error,
      record: { ...current.record, phase: 'commit-uncertain' as const },
      updatedAt: this.now().toISOString(),
    }
    writeAtomic(this.dir, next)
    return next
  }

  resolveCommitted(
    record: TransferRecord,
    cleanup?: { result: 'cleaned' | 'pending'; detail?: string },
  ): TransferJournalEntry {
    const current = this.required()
    if (current.state === 'committed') return current
    if (current.state !== 'commit-uncertain') {
      throw new Error('cannot resolve committed transfer from ' + current.state)
    }
    const { error: _error, ...withoutError } = current
    const next = {
      ...withoutError,
      state: 'committed' as const,
      record: { ...record, phase: 'switching' as const, targetProof: true, sourceConnected: false },
      ...(cleanup ? { cleanup } : {}),
      updatedAt: this.now().toISOString(),
    }
    writeAtomic(this.dir, next)
    return next
  }

  clearReviewedOutcome(): void {
    const current = this.read()
    if (!current) return
    if (current.state !== 'aborted') {
      throw new Error(`cannot clear unreviewed transfer journal in ${current.state}`)
    }
    unlinkSync(this.path)
    fsyncDirectory(this.dir)
  }

  private required(): TransferJournalEntry {
    const current = this.read()
    if (!current) throw new Error('transfer journal does not exist')
    return current
  }
}
/**
 * Called before SessionStore opens its writable SQLite connection. The journal
 * is the boot recovery authority: fenced, uncertain, and committed sources may
 * never silently reopen as a server.
 */
export function reconcileSafeServerTransferBoot(
  stateRoot: string,
): TransferJournalEntry | undefined {
  const journal = new TransferJournal(join(stateRoot, '.server-transfer'))
  const entry = journal.read()
  if (!entry || !safelyRecoverableBeforeFence(entry.state)) return entry
  return journal.abort(
    { code: 'boot-recovery', message: 'aborted stale pre-fence transfer in ' + entry.state },
    { result: 'pending', detail: 'target staging cleanup must be reconciled online' },
  )
}

export type ServerTransferBootMode = 'writable' | 'daemon-only' | 'recovery-only'

export function serverTransferBootMode(stateRoot: string): ServerTransferBootMode {
  const entry = new TransferJournal(join(stateRoot, '.server-transfer')).read()
  if (!entry || entry.state === 'aborted') return 'writable'
  if (entry.state === 'committed') return 'daemon-only'
  if (blocksWritableServer(entry.state)) return 'recovery-only'
  return 'writable'
}

export function assertWritableServerBoot(stateRoot: string): void {
  const entry = new TransferJournal(join(stateRoot, '.server-transfer')).read()
  if (entry && blocksWritableServer(entry.state)) {
    throw new Error(`server transfer journal is ${entry.state}; refusing writable server boot`)
  }
}
