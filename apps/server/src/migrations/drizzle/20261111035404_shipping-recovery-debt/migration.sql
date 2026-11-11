CREATE TABLE `ship_recovery_work` (
	`key` text PRIMARY KEY,
	`kind` text NOT NULL,
	`order_id` text NOT NULL,
	`payload` text NOT NULL,
	CONSTRAINT `fk_ship_recovery_work_order_id_ship_orders_id_fk` FOREIGN KEY (`order_id`) REFERENCES `ship_orders`(`id`) ON DELETE RESTRICT,
	CONSTRAINT "ship_recovery_work_kind_check" CHECK(kind IN ('daemon-ack', 'repair-ack', 'descendants'))
);
--> statement-breakpoint
CREATE INDEX `idx_ship_orders_repo_state_id` ON `ship_orders` (`repo_id`,`state`,`id`);--> statement-breakpoint
CREATE INDEX `idx_ship_orders_recovery` ON `ship_orders` (`requested_at`,`id`) WHERE state IN ('preflight', 'composing', 'validating', 'repairing', 'landing', 'publishing', 'verifying');--> statement-breakpoint
CREATE INDEX `idx_ship_recovery_work_kind_key` ON `ship_recovery_work` (`kind`,`key`);--> statement-breakpoint
CREATE INDEX `idx_ship_recovery_work_order` ON `ship_recovery_work` (`order_id`);
--> statement-breakpoint
-- A pre-debt server never recorded acknowledgement completion. Conservatively
-- enqueue its terminal daemon effects ONCE during upgrade, including held and
-- shipped orders. Subsequent boots consume only this indexed outstanding set.
INSERT INTO ship_recovery_work (key, kind, order_id, payload)
SELECT 'legacy-daemon:' || id, 'daemon-ack', order_id, json_object('stepId', id)
FROM ship_steps
WHERE state IN ('succeeded', 'failed', 'cancelled')
  AND kind IN ('preflight', 'apply-repair', 'prepare-merge-group', 'validate', 'commit-merge-group', 'publish', 'verify')
  AND outcome <> 'authorization-refused';
--> statement-breakpoint
INSERT OR IGNORE INTO ship_recovery_work (key, kind, order_id, payload)
SELECT 'repair:' || result_token, 'repair-ack', order_id,
  json_object('resultToken', result_token, 'orderId', order_id, 'attemptId', attempt_id,
    'generation', generation, 'contextDigest', context_digest,
    'candidate', json_object('repairRef', repair_ref, 'candidateHeadSha', candidate_head_sha))
FROM ship_repair_candidates;
--> statement-breakpoint
INSERT OR IGNORE INTO ship_recovery_work (key, kind, order_id, payload)
SELECT 'repair:' || json_extract(marker, '$.acknowledgement.resultToken'), 'repair-ack', order_id,
  json_extract(marker, '$.acknowledgement')
FROM (
  SELECT order_id,
    CASE WHEN json_valid(substr(summary, length('shipping-repair:v2:') + 1))
      THEN substr(summary, length('shipping-repair:v2:') + 1) ELSE NULL END AS marker
  FROM ship_steps
  WHERE substr(summary, 1, length('shipping-repair:v2:')) = 'shipping-repair:v2:'
)
WHERE json_extract(marker, '$.decision.kind') = 'needs-decision'
  AND json_type(marker, '$.acknowledgement') = 'object'
  AND json_extract(marker, '$.acknowledgement.resultToken') IS NOT NULL;
--> statement-breakpoint
INSERT INTO ship_recovery_work (key, kind, order_id, payload)
SELECT 'descendants:' || r.id, 'descendants', r.order_id,
  json_object('destinationSha', r.destination_sha)
FROM delivery_receipts r JOIN ship_orders o ON o.id = r.order_id
WHERE o.state = 'shipped';
