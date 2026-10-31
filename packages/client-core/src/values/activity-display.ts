import {
  type ActivityStretchRow,
  type ChatBlock,
  isBatchableTool,
  type ToolMail,
  transcriptActivityFacts,
} from './chat'
import type { ParsedEnvelopeBatch } from './message-envelope'

interface SingletonDisplayBase {
  readonly block: ChatBlock
  /** A single note or inbox read uses its member's own line and disclosure. */
  readonly inline: boolean
  /** A multi-envelope item still needs the stretch glyph and chevron. */
  readonly multiple: boolean
  /** Logical row treatment only; the owning stretch component and key stay put. */
  readonly asBlock: boolean
}

export type ActivitySingletonDisplay = SingletonDisplayBase &
  (
    | { readonly kind: 'received-notes'; readonly batch: ParsedEnvelopeBatch }
    | { readonly kind: 'sent-note'; readonly mail: Extract<ToolMail, { op: 'note' }> }
    | { readonly kind: 'inbox-read'; readonly mail: Extract<ToolMail, { op: 'inbox' }> }
    | { readonly kind: 'tool' }
  )

/** Shared singleton and member treatment for retained and snapshot readers. */
export function activitySingletonDisplay(block: ChatBlock): ActivitySingletonDisplay {
  const batch = transcriptActivityFacts(block.item).envelopes
  if (batch)
    return {
      kind: 'received-notes',
      block,
      batch,
      inline: batch.envelopes.length === 1,
      multiple: batch.envelopes.length > 1,
      asBlock: true,
    }
  const asBlock = !isBatchableTool(block.item)
  if (block.mail?.op === 'note')
    return {
      kind: 'sent-note',
      block,
      mail: block.mail,
      inline: true,
      multiple: false,
      asBlock,
    }
  if (block.mail?.op === 'inbox')
    return {
      kind: 'inbox-read',
      block,
      mail: block.mail,
      inline: true,
      multiple: false,
      asBlock,
    }
  return { kind: 'tool', block, inline: false, multiple: false, asBlock }
}

interface SingletonSource {
  readonly singletonDisplay: ActivitySingletonDisplay | undefined
}

/** A retained reader must never fall back to materializing all run members. */
export function activityRowSingletonDisplay(
  row: ActivityStretchRow,
  source?: SingletonSource,
): ActivitySingletonDisplay | undefined {
  if (source) return source.singletonDisplay
  return row.blocks.length === 1 && row.blocks[0]
    ? activitySingletonDisplay(row.blocks[0])
    : undefined
}

/** Forced disclosure is temporary and never changes retained user intent or
 * emits a callback. Explicit toggles and opens report user intent, even while
 * forceOpen pins the member open. Closing a member need not close its stretch. */
export interface ActivityDisclosureProps {
  readonly forceOpen?: boolean | undefined
  readonly onOpenChange?: ((open: boolean) => void) | undefined
}
