# planted — the lint fence's fixture arm (POD-4563)

Not an arm: files the lint fence tests plant mistakes into
(`harness/lint/fence-lint.test.ts`). As a clean arm it lints to zero errors.

Enumeration allow-list: `visible.ts` (the visible-set builder) is the only
module that may enumerate `issues`, `sessions` or `worktrees`.
