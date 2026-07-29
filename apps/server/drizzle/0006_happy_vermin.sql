CREATE TABLE `schedules` (
	`id` text PRIMARY KEY NOT NULL,
	`workflow_id` text NOT NULL,
	`interval_seconds` integer NOT NULL,
	`enabled` integer DEFAULT true NOT NULL,
	`budget_usd_per_run` real NOT NULL,
	`budget_usd_total` real NOT NULL,
	`max_runs` integer NOT NULL,
	`spent_usd` real DEFAULT 0 NOT NULL,
	`runs` integer DEFAULT 0 NOT NULL,
	`next_run_at` integer NOT NULL,
	`last_run_at` integer,
	`disabled_reason` text,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`workflow_id`) REFERENCES `workflows`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `schedules_due_idx` ON `schedules` (`enabled`,`next_run_at`);