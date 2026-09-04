ALTER TABLE `machines` ADD `presence_source` text;--> statement-breakpoint
ALTER TABLE `machines` ADD `service_assignment_json` text DEFAULT '{"server":false,"agentExecution":true}' NOT NULL;--> statement-breakpoint
-- Preserve every already-recorded topology across the supervisor cutover.
-- NULL components predate topology reporting, so retain the enrollment default
-- (agents on, no server); evaluated rows map daemon -> agentExecution and server -> server.
UPDATE `machines`
   SET `service_assignment_json` =
     '{"server":' ||
     CASE WHEN `components_json` LIKE '%"server"%' THEN 'true' ELSE 'false' END ||
     ',"agentExecution":' ||
     CASE WHEN `components_json` LIKE '%"daemon"%' THEN 'true' ELSE 'false' END ||
     '}'
 WHERE `components_json` IS NOT NULL;
--> statement-breakpoint
ALTER TABLE `machines` ADD `service_report_json` text;--> statement-breakpoint
ALTER TABLE `machines` DROP COLUMN `supervised`;