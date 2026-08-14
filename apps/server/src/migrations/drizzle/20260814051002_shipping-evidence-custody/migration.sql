CREATE TABLE `ship_evidence` (
	`ref` text PRIMARY KEY,
	`custody_digest` text NOT NULL,
	`content_digest` text NOT NULL,
	`source_ref` text NOT NULL,
	`content` text NOT NULL,
	`materialized_at` text NOT NULL,
	CONSTRAINT "ship_evidence_custody_digest_check" CHECK(length(custody_digest) = 64 AND custody_digest NOT GLOB '*[^a-f0-9]*'),
	CONSTRAINT "ship_evidence_content_digest_check" CHECK(length(content_digest) = 64 AND content_digest NOT GLOB '*[^a-f0-9]*')
);
--> statement-breakpoint
CREATE TRIGGER `ship_evidence_update_immutable`
BEFORE UPDATE ON `ship_evidence`
BEGIN SELECT RAISE(ABORT, 'ship evidence is immutable'); END;
--> statement-breakpoint
CREATE TRIGGER `ship_evidence_delete_immutable`
BEFORE DELETE ON `ship_evidence`
BEGIN SELECT RAISE(ABORT, 'ship evidence is immutable'); END;
