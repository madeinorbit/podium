export type PickerSource = 'Photos' | 'Files'

export type PickerFailure = { cancelled: true } | { cancelled: false; message: string }

/** One seam shared by the native Photos and Files launchers. It keeps a real
 * OS cancellation empty while turning permission and launcher failures into a
 * rejected source that the composer renders as a removable failed chip. */
export async function openNativePicker<T>(
  source: PickerSource,
  launch: () => Promise<{ cancelled: boolean; value: T }>,
): Promise<T | null> {
  try {
    const result = await launch()
    return result.cancelled ? null : result.value
  } catch (error) {
    const failure = classifyPickerFailure(source, error)
    if (failure.cancelled) return null
    throw new Error(failure.message)
  }
}

/** Cancellation leaves no trace. Permission denial is different: the operator
 * must know how to recover, and the composer's failed chip keeps that route
 * visible without creating an upload session. */
export function classifyPickerFailure(source: PickerSource, error: unknown): PickerFailure {
  const code =
    typeof error === 'object' && error ? String((error as { code?: unknown }).code ?? '') : ''
  const reason = error instanceof Error ? error.message : String(error)
  if (/cancel/i.test(code) || /cancel/i.test(reason)) return { cancelled: true }
  if (/permission|denied|rejected/i.test(`${code} ${reason}`)) {
    return {
      cancelled: false,
      message: `${source} access was denied. Allow access in Settings, then try again.`,
    }
  }
  return {
    cancelled: false,
    message: reason
      ? `Could not open ${source}: ${reason}`
      : `Could not open ${source}. Try again.`,
  }
}
