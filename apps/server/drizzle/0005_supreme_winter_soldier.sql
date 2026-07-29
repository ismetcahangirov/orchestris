CREATE TABLE `workflow_runs` (
	`id` text PRIMARY KEY NOT NULL,
	`workflow_id` text NOT NULL,
	`trigger` text DEFAULT 'manual' NOT NULL,
	`status` text DEFAULT 'running' NOT NULL,
	`steps_json` text NOT NULL,
	`started_at` integer NOT NULL,
	`ended_at` integer,
	`error` text,
	FOREIGN KEY (`workflow_id`) REFERENCES `workflows`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `workflow_runs_wf_idx` ON `workflow_runs` (`workflow_id`,`started_at`);--> statement-breakpoint
CREATE TABLE `workflow_step_runs` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`workflow_run_id` text NOT NULL,
	`step_id` text NOT NULL,
	`step_index` integer NOT NULL,
	`kind` text NOT NULL,
	`attempt` integer DEFAULT 1 NOT NULL,
	`task_id` text,
	`status` text DEFAULT 'running' NOT NULL,
	`output` text DEFAULT '' NOT NULL,
	`output_truncated` integer DEFAULT false NOT NULL,
	`detail` text,
	`started_at` integer NOT NULL,
	`ended_at` integer,
	FOREIGN KEY (`workflow_run_id`) REFERENCES `workflow_runs`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `workflow_step_runs_run_idx` ON `workflow_step_runs` (`workflow_run_id`,`id`);--> statement-breakpoint
CREATE TABLE `workflows` (
	`id` text PRIMARY KEY NOT NULL,
	`context_id` text NOT NULL,
	`name` text NOT NULL,
	`description` text,
	`steps_json` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`archived_at` integer,
	FOREIGN KEY (`context_id`) REFERENCES `contexts`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `workflows_context_idx` ON `workflows` (`context_id`,`created_at`);