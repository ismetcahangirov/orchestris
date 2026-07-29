CREATE TABLE `task_templates` (
	`id` text PRIMARY KEY NOT NULL,
	`task_type` text NOT NULL,
	`worker_prompt` text NOT NULL,
	`rubric` text NOT NULL,
	`authored_by_model_id` text NOT NULL,
	`authoring_run_id` text,
	`authoring_cost_usd` real,
	`uses` integer DEFAULT 0 NOT NULL,
	`escalations_after` integer DEFAULT 0 NOT NULL,
	`created_at` integer NOT NULL,
	`last_used_at` integer
);
--> statement-breakpoint
CREATE UNIQUE INDEX `task_templates_type_idx` ON `task_templates` (`task_type`);