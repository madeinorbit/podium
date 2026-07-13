import { toast } from 'sonner'

/**
 * Copy `text` with a toast confirming what landed on the clipboard — the shared
 * path for the issue-id chips and other one-click copy affordances, so feedback
 * is consistent everywhere (issue #21).
 */
export function copyToClipboard(text: string, label = 'Copied to clipboard'): void {
  void navigator.clipboard
    ?.writeText(text)
    .then(() => toast.success(label))
    .catch(() => toast.error('Could not copy to clipboard'))
}
