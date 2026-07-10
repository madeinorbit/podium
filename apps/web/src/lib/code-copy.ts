import { toast } from 'sonner'

/**
 * Click handler for the copy button the markdown code renderer injects into every
 * `<pre>` (see COPY_BUTTON in markdown.ts). Returns true when the click targeted a
 * copy button, so a container's delegated onClick can stop after handling it (and
 * before its file-link logic). The code text is read from the sibling `<code>` at
 * click time — never duplicated into the markup — so it always matches what's shown.
 */
export function handleCodeCopyClick(e: {
  target: EventTarget | null
  preventDefault: () => void
}): boolean {
  const target = e.target as HTMLElement | null
  const btn = target?.closest?.('.code-copy') as HTMLElement | null
  if (!btn) return false
  e.preventDefault()
  const code = btn.closest('pre')?.querySelector('code')?.textContent ?? ''
  if (!code) return true
  void navigator.clipboard
    ?.writeText(code)
    .then(() => toast.success('Copied to clipboard'))
    .catch(() => toast.error('Could not copy to clipboard'))
  return true
}
