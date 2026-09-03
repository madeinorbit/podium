# OpenCode exact-tip A7a refusal

Recorded 2026-08-30T13:06:16+02:00. The issue branch and local `issue/1761-agent-runtime` both resolved to exact pin `4fd5a05b6b1a80f89494377400a5207271eed198` before launch.

The A7a re-drive is **REFUSED and unscored** because the browser positive control did not launch. Playwright started the pinned Chromium headless shell, which exited with code 127 before opening a page because the host lacked `libasound.so.2`; no Podium session was created and no OpenCode provider prompt was sent.

All preceding placement and isolation controls passed: the worktree and branch were exact and clean; server, daemon, and served web bundle booted at `4fd5a05b6b1a80f89494377400a5207271eed198`; the fresh named instance was `p3112-a7a-final-1108`; ports were `21483`, `48483`, and `48484`; and the fresh repo was `/tmp/pod-3112-a7a-final-20260830t1108z/dummy-repo`. OpenCode was version `1.18.25` at SHA-256 `d91e0d33676d0839f7cde87924cd4127ea88c9d6784eea9f009a7d08bdc60eeb`, with the approved named-home credential symlink after marker verification; no credential bytes were read or copied.

The isolated daemon and server were stopped, the credential symlink was deleted, and no matching instance process remained. A7b was not attempted. No acceptance-ledger row was appended because the explicit control-failure rule requires refusal without scoring; writing PASS or FAIL would misclassify an unexercised product boundary.
