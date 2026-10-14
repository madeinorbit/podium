CREATE TABLE `agent_profiles` (
	`id` text PRIMARY KEY,
	`name` text NOT NULL CONSTRAINT `agent_profiles_name_unique` UNIQUE,
	`description` text DEFAULT '' NOT NULL,
	`candidates_json` text DEFAULT '[]' NOT NULL,
	`machine_id` text,
	`instructions` text DEFAULT '' NOT NULL,
	`created_by` text,
	`updated_by` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
ALTER TABLE `issues` ADD `agent_profile_id` text;--> statement-breakpoint
ALTER TABLE `sessions` ADD `agent_profile_id` text;
--> statement-breakpoint
-- Starter profiles: the six task roles of the flight deck design (D4). Plain
-- rows a person may edit or delete; this migration never runs again, so a
-- deleted starter stays deleted.
INSERT OR IGNORE INTO `agent_profiles` (`id`, `name`, `description`, `candidates_json`, `machine_id`, `instructions`, `created_by`, `updated_by`, `created_at`, `updated_at`) VALUES
  ('agp_seed_research', 'research', 'Finds things out and reports them; changes no product code.', '[{"harness":"claude-code","model":"auto","effort":"high"},{"harness":"codex","model":"auto","effort":"high"}]', NULL, 'You are on a research task.

- Answer the question the issue asks; do not change product code.
- Cite what you rely on: file:line for code, links for outside sources.
- Separate what you observed from what you infer.
- End with a short written summary attached to the issue.', 'system:seed', 'system:seed', '2026-10-14T00:00:00.000Z', '2026-10-14T00:00:00.000Z'),
  ('agp_seed_design', 'design', 'Shapes a feature or interface before it is built.', '[{"harness":"claude-code","model":"auto","effort":"high"}]', NULL, 'You are on a design task.

- Produce the design itself (a document, mockup or prototype) and attach it to the issue.
- For each real decision, give the options, their tradeoffs and your recommendation.
- Ask your coordinator before choosing between options that change scope.', 'system:seed', 'system:seed', '2026-10-14T00:00:00.000Z', '2026-10-14T00:00:00.000Z'),
  ('agp_seed_build', 'build', 'Implements a scoped change with focused tests.', '[{"harness":"claude-code","model":"auto","effort":"high"},{"harness":"codex","model":"auto","effort":"high"}]', NULL, 'You are on a build task.

- Implement what the issue scopes, following the repository''s own instructions.
- Run the focused tests for what you touched, not the full suite.
- Commit in small steps and move the issue to review when it is done.', 'system:seed', 'system:seed', '2026-10-14T00:00:00.000Z', '2026-10-14T00:00:00.000Z'),
  ('agp_seed_review', 'review', 'Reviews a change for correctness before it lands.', '[{"harness":"codex","model":"auto","effort":"high"},{"harness":"claude-code","model":"auto","effort":"high"}]', NULL, 'You are on a review task.

- Check correctness first, then tests, then clarity.
- Verify every finding before you report it: name the input that breaks and what happens.
- Report findings; do not rewrite the change yourself unless asked.', 'system:seed', 'system:seed', '2026-10-14T00:00:00.000Z', '2026-10-14T00:00:00.000Z'),
  ('agp_seed_qa', 'qa', 'Exercises a change as a user would and pins failures with tests.', '[{"harness":"claude-code","model":"auto","effort":"medium"},{"harness":"codex","model":"auto","effort":"medium"}]', NULL, 'You are on a QA task.

- Exercise the change the way a user would, including edge cases.
- For each failure, write reproducible steps and the expected and actual result.
- Add a regression test where one is practical.', 'system:seed', 'system:seed', '2026-10-14T00:00:00.000Z', '2026-10-14T00:00:00.000Z'),
  ('agp_seed_security', 'security', 'Audits code for vulnerabilities and rates them.', '[{"harness":"claude-code","model":"auto","effort":"high"},{"harness":"codex","model":"auto","effort":"high"}]', NULL, 'You are on a security task.

- Look for vulnerabilities in the scoped code and rate each by severity and reach.
- Never run destructive or outward-facing actions to prove a finding.
- Report findings with a fix suggestion; change code only when asked.', 'system:seed', 'system:seed', '2026-10-14T00:00:00.000Z', '2026-10-14T00:00:00.000Z');
