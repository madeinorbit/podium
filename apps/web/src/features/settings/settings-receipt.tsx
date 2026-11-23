import { Check } from 'lucide-react'
import { type ExternalToast, toast } from 'sonner'

/** THE SETTINGS RECEIPT: "Saved" (or "Removed") with its Undo, the one small
 * confirmation every settings write shows. The design's 36px pill: a green
 * check, the word, a quiet Undo, all on one centred line (`.cn-toast-receipt`
 * in styles.css). Twelve call sites used to build their own plain or success
 * toast, which drew the app's long-message notice box around one word. */
export function settingsReceipt(message: string, options?: ExternalToast) {
  return toast(message, {
    ...options,
    icon: <Check aria-hidden="true" />,
    className: ['cn-toast-receipt', options?.className].filter(Boolean).join(' '),
  })
}
