/** Untimed per-click MenuRoot census. Pair with the measurement-only transform
 * below; no observer or counter is installed in the shipping application. */
import type { Page } from '@playwright/test'

export const STATUS_MENU_MOUNT_LIMIT = 6

export type MenuMountCount = { mounted: number; live: number }

/** Use the actual Base UI function identity, including in minified builds. */
export function exposeMenuRoot(code: string, id: string): string {
  return id.endsWith('/components/ui/dropdown-menu.tsx')
    ? `${code}\nObject.assign(globalThis, { __statusMenuRootType: MenuPrimitive.Root });\n`
    : code
}

export function assertIdleMenuMounts(count: MenuMountCount): void {
  if (count.mounted > STATUS_MENU_MOUNT_LIMIT) {
    throw new Error(
      `MenuRoot mount guard: ${count.mounted} mounted before menu intent (limit ${STATUS_MENU_MOUNT_LIMIT})`,
    )
  }
}

type Fiber = {
  type: unknown
  tag: number
  alternate: Fiber | null
  child: Fiber | null
  sibling: Fiber | null
}

declare global {
  interface Window {
    __statusMenuRootType?: unknown
    __statusMenuMounts: { begin(): void; read(): MenuMountCount }
  }
}

/** React's ordinary renderer calls the DevTools commit hook. Count each actual
 * root once on mount, excluding cloned/reused fibers and updates. Run only in
 * the structural pass, outside the timed collector's input-to-Paint interval. */
export async function installStatusMenuMountGuard(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const seen = new WeakSet<Fiber>()
    const rootCounts = new WeakMap<object, number>()
    let mounted = 0
    let live = 0
    let before = 0
    window.__statusMenuMounts = {
      begin() {
        if (typeof window.__statusMenuRootType !== 'function') {
          throw new Error('MenuRoot mount guard is unarmed')
        }
        before = mounted
      },
      read: () => ({ mounted: mounted - before, live }),
    }
    const host = window as unknown as {
      __REACT_DEVTOOLS_GLOBAL_HOOK__?: {
        inject?(renderer: unknown): number
        onCommitFiberRoot?(id: number, root: { current: Fiber }): void
      }
    }
    const previous = host.__REACT_DEVTOOLS_GLOBAL_HOOK__
    host.__REACT_DEVTOOLS_GLOBAL_HOOK__ = {
      ...previous,
      ...{
        supportsFiber: true,
        checkDCE() {},
        onCommitFiberUnmount() {},
        inject: (renderer: unknown) => previous?.inject?.(renderer) ?? 1,
      },
      onCommitFiberRoot(id, root) {
        let count = 0
        const stack = [root.current]
        while (stack.length) {
          const fiber = stack.pop()!
          if (fiber.sibling) stack.push(fiber.sibling)
          if (fiber.child) stack.push(fiber.child)
          if (fiber.tag !== 0 || fiber.type !== window.__statusMenuRootType) continue
          count++
          if (!seen.has(fiber) && (!fiber.alternate || !seen.has(fiber.alternate))) mounted++
          seen.add(fiber)
        }
        live += count - (rootCounts.get(root) ?? 0)
        rootCounts.set(root, count)
        previous?.onCommitFiberRoot?.(id, root)
      },
    }
  })
}
