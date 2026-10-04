# POD-5506 chat composer latency

Measurement in progress. Baseline source: `1aa0ec71f6` (dev.246), production React on ludovico, isolated loopback preview proxying the existing live local backend.

The capture types 60 synthetic characters at approximately 100 ms intervals into a busy agent chat composer. Reports retain only counts, timings, source function names and build provenance. Session cookies and operator records stay in memory on ludovico.

Before product edits, compare the baseline with throwaway builds disabling measured causes individually. Final validation uses focused files, typechecks and lint on flatblock in `~/podium-test-5506` with its copied `.toolchain`. Land by fast-forward on `integrate/4286-pilot` after rebasing onto POD-5497; preserve offline and reload draft-ledger semantics.
