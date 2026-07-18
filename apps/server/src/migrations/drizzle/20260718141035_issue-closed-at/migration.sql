ALTER TABLE `issues` ADD `closed_at` text;--> statement-breakpoint
-- Legacy closed rows get a FIXED anchor (their last touch at migration time) so
-- historical done issues decay deterministically instead of resurfacing. [spec:SP-6144]
UPDATE issues SET closed_at = updated_at
WHERE closed_at IS NULL AND (stage = 'done' OR closed_reason IS NOT NULL);
