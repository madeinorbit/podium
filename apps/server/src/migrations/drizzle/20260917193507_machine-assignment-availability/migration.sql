ALTER TABLE `machines` ADD `assignment_evidence_json` text;--> statement-breakpoint
ALTER TABLE `machines` ADD `availability_json` text;--> statement-breakpoint
-- POD-4142, evidence format v1. Preserve explicit non-default assignments.
-- The 20260826195939 migration synthesized daemon-only defaults. Coordinator
-- decision 2026-09-17: legacy paired-only rows retain daemon assignment (the
-- old pairing ceremony was daemon-led); this exception never grants availability.
-- Supervisor-only enrollment is distinct evidence and must not gain a daemon.
-- Transfer changes only the server bit; S5 relocates boot promotion side effects.
UPDATE machines SET service_assignment_json =
 CASE
   WHEN json_valid(service_assignment_json) AND
        json_type(service_assignment_json, '$.server') IN ('true','false') AND
        json_type(service_assignment_json, '$.agentExecution') IN ('true','false') AND
        (json_extract(service_assignment_json, '$.server') = 1 OR json_extract(service_assignment_json, '$.agentExecution') = 0)
     THEN service_assignment_json
   WHEN json_valid(components_json) AND json_type(components_json) = 'array'
     THEN json_object('server', json(CASE WHEN EXISTS(SELECT 1 FROM json_each(components_json) WHERE value = 'server') THEN 'true' ELSE 'false' END),
                      'agentExecution', json(CASE WHEN EXISTS(SELECT 1 FROM json_each(components_json) WHERE value = 'daemon') THEN 'true' ELSE 'false' END))
   WHEN presence_source = 'supervisor' AND inventory_json IS NULL
     THEN '{"server":false,"agentExecution":false}'
   ELSE '{"server":false,"agentExecution":true}'
 END;
--> statement-breakpoint
UPDATE machines SET assignment_evidence_json = json_object(
 'version', 1, 'source', 'migration-20260917-legacy-evidence', 'requestId', id);
-- No historical report proves a socket is attached to this server run.
-- availability_json remains NULL until an attach/detach transition records it.
