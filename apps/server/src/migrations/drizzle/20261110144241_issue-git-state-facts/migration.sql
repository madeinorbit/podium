CREATE TABLE `issue_git_states` (
	`issue_id` text PRIMARY KEY,
	`facts_json` text NOT NULL,
	`updated_at` text NOT NULL,
	CONSTRAINT `fk_issue_git_states_issue_id_issues_id_fk` FOREIGN KEY (`issue_id`) REFERENCES `issues`(`id`) ON DELETE CASCADE
);

--> statement-breakpoint
INSERT INTO issue_git_states (issue_id, facts_json, updated_at)
SELECT c.entity_id, json_remove(c.payload, '$.id', '$.updatedAt'), json_extract(c.payload, '$.updatedAt')
FROM change_latest c JOIN issues i ON i.id = c.entity_id
WHERE c.entity = 'issueGitState' AND i.deleted_at IS NULL;
