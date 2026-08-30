# OpenCode Native-repair A7a adjudication

Recorded 2026-08-30T12:27:39.379933+02:00. Pin `ba420c5665888f6bd8338e02df9867bf36a34320` on `issue/1761-agent-runtime`; issue branch head `9be131d10859734d83b73a976bd649f9630a5f7d`.

A7a is **REFUSED and unscored**. The one provider conversation, exact server-driver identity, Chat transcript, and context recall survived daemon PID `3963576` → `3996993`, but the content-bearing Native marker did not: normalized occurrences changed from `2` before restart to `0` afterward. Chat retained `2` occurrences and recall succeeded in `2183.9 ms`.

All setup and liveness controls fired: seed user/assistant counts were `1/1`, provider prompts were `2`, adoption took `1395.4 ms`, provider/session/process/created-at/resume identities remained equal, and the post-restart provider PID was live in the exact fresh cwd and instance. Credential posture was the approved named-home symlink after marker verification; no credential bytes were read, copied, printed, or committed.

No eight-field acceptance row was written. No `a7a-ready`/`a7a-continue` marker was emitted, and A7b was not attempted. The sibling JSON contains only redacted structural fields and SHA-256 hashes of the raw temporary readings.
