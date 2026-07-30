# `annotations/` — reserved (POD-304)

Per-field annotations and the totality test that stops a new field escaping them: conflict class
(`exp-rev` / `field-LWW` / `single-writer` / `append` / `cmd` / `op-stream`), permitted writers,
and — per `docs/multi-user-readiness.md` §3.1.1 — the visibility class, which must be
**default-closed**: an entity class with no declared visibility is personal/private, never
tenant-visible.

Empty today by design; POD-299 reserved the home.
