import { useEffect, useState } from 'react'

const NO_LABELS: readonly string[] = []

/**
 * The labels a label menu offers: the server's label list, asked for when
 * the menu opens and dropped when it closes (a request answer). There are
 * no label records, and the device does not hold every issue, so the menu
 * never derives its choices from the issues it holds (POD-7088).
 */
export function useLabelPool(
  open: boolean,
  list: () => Promise<readonly { readonly name: string }[]>,
): readonly string[] {
  const [labels, setLabels] = useState<readonly string[]>(NO_LABELS)
  // biome-ignore lint/correctness/useExhaustiveDependencies: the list is asked for once per opening
  useEffect(() => {
    if (!open) {
      setLabels(NO_LABELS)
      return
    }
    let current = true
    void list().then(
      (rows) => {
        if (current) setLabels([...new Set(rows.map((row) => row.name))].sort())
      },
      () => {
        if (current) setLabels(NO_LABELS)
      },
    )
    return () => {
      current = false
    }
  }, [open])
  return labels
}
