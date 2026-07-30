# Podium redesign — product decisions (from Till, 2026-07-14)

- **Issue colours**: user-assigned via a colour picker with 10 predefined colours; each triggers predefined colouring of the colourable UI parts. Default (no colour) = grey-black-ish neutral — covered in the design doc. Colour picker UI is in the updated handoff.
- **Issue IDs**: POD-128-style ids will arrive via a push from a colleague. For now KEEP the current id scheme and just render it in the new square style; wiring real prefixes comes later.
- **Rollout**: BIG BANG. The old layout is not needed anymore (product not live). Replace the shell outright, no feature flag.
- **Quota meters**: the header meters are the same data as today's footer (machine + Claude Code quota), just redesigned.
- **Resizable sections**: EVERY section is resizable, even where the design doesn't explicitly show it.
- Logo: .design/podium-logo.svg (from the design project).
