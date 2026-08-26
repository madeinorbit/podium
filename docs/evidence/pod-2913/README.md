# POD-2913 — review-queue drives

This report records only evidence taken for the nine landed-but-never-driven
children named by the 2026-08-26 23:19 CEST review-queue audit. A finding that
cannot establish the required pre-fix boundary is recorded as UNDRIVEN; no
repair is included here.

## Protocol

Each scored drive must reproduce the symptom at the parent of the listed fix,
then show it gone at the epic tip. The server, web bundle, and daemon must be
pinned to the same commit before each reading; the daemon pin is the SHA written
at process spawn. Each drive also needs a positive control and one isolated,
named instance.

## Findings

### POD-2622 — invalid pre-fix boundary

The audit names 'b266484d8'. Its parent is '1641d823c'. The substantive
child-environment changes are already present in the parent ancestry
('aa8cdacff' and 'aba4d4ff9'); the listed commit is a reconciliation/formatting
boundary rather than the first fix. A probe at 'b266484d8^' therefore cannot
reproduce the pre-fix symptom. Verdict: **UNDRIVEN — invalid listed boundary**.
No live yes/no result was inferred.

### POD-2773 — invalid pre-fix boundary; Grok unavailable

The audit names 'e38128936', whose parent is '4578be8d'. The listed commit is
docs-only ('docs/evidence/pod-2773/README.md'); the streaming implementation is
already in its parent. A probe at 'e38128936^' therefore cannot be the required
pre-fix control. Verdict: **UNDRIVEN — invalid listed boundary**.

The Grok driver is separately **UNDRIVEN** while its provider quota is
unavailable until '2026-08-27 11:03 CEST'; it produced no token. OpenCode
evidence is not used to infer Grok.

### POD-2761 — runtime gate, no reading

The exact pre-fix checkout 'a841ade7407d91e72e946d05ebd281fe59f557b6' was
prepared for the Chat → CLI → Chat → CLI Codex probe. No server, web bundle, or
daemon was started and no reading was scored because the shared test:heavy
lease was held by POD-1761. At '2026-08-27 00:26 CEST', the host reported
709 MiB free memory, 5.6 GiB available memory, load 8.87/13.08/15.12, and
16 GiB free disk; the host had active swap pressure earlier in the same gate
window. Starting a Vite build under that lease would invalidate the reading.

## Ledger

Complete rows are appended to 'docs/plans/pod-1761-results.tsv'. The remaining
children (POD-2298, POD-2408, POD-2602, POD-2604, POD-2637, and POD-2691) were
not touched in this gated interval and have no result claimed here.

Last evidence update: '2026-08-27 00:26 CEST'.
