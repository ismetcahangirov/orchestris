CREATE TABLE `cache_entries` (
	`hash` text PRIMARY KEY NOT NULL,
	`model_id` text NOT NULL,
	`runner_id` text NOT NULL,
	`events_json` text NOT NULL,
	`hits` integer DEFAULT 0 NOT NULL,
	`created_at` integer NOT NULL,
	`last_hit_at` integer
);
--> statement-breakpoint
CREATE INDEX `cache_model_idx` ON `cache_entries` (`model_id`);--> statement-breakpoint
CREATE TABLE `contexts` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`cwd` text,
	`amplification_profile` text DEFAULT 'balanced' NOT NULL,
	`worker_mode` text DEFAULT 'auto' NOT NULL,
	`auto_submode` text DEFAULT 'cheap' NOT NULL,
	`default_worker_model_id` text,
	`verify_commands_json` text DEFAULT '[]' NOT NULL,
	`budget_tokens` integer,
	`budget_usd` real,
	`budget_seconds` integer,
	`max_parallel` integer DEFAULT 1 NOT NULL,
	`created_at` integer NOT NULL,
	`archived_at` integer
);
--> statement-breakpoint
CREATE TABLE `models` (
	`id` text PRIMARY KEY NOT NULL,
	`provider_id` text NOT NULL,
	`model_id` text NOT NULL,
	`display_name` text NOT NULL,
	`context_limit` integer,
	`output_limit` integer,
	`price_in` real,
	`price_out` real,
	`price_cache_read` real,
	`price_cache_write` real,
	`tool_call` integer DEFAULT false NOT NULL,
	`structured_output` integer DEFAULT false NOT NULL,
	`reasoning` integer DEFAULT false NOT NULL,
	`source` text DEFAULT 'models.dev' NOT NULL,
	`enabled` integer DEFAULT true NOT NULL,
	`role_boss` integer DEFAULT false NOT NULL,
	`role_worker` integer DEFAULT false NOT NULL,
	`role_classifier` integer DEFAULT false NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`provider_id`) REFERENCES `providers`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `models_provider_idx` ON `models` (`provider_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `models_single_boss_idx` ON `models` (`role_boss`) WHERE "models"."role_boss" = 1;--> statement-breakpoint
CREATE UNIQUE INDEX `models_single_classifier_idx` ON `models` (`role_classifier`) WHERE "models"."role_classifier" = 1;--> statement-breakpoint
CREATE TABLE `providers` (
	`id` text PRIMARY KEY NOT NULL,
	`kind` text DEFAULT 'api' NOT NULL,
	`display_name` text NOT NULL,
	`credential_ref` text,
	`enabled` integer DEFAULT true NOT NULL,
	`last_discovery_at` integer,
	`last_discovery_error` text,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `routing_decisions` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`task_id` text NOT NULL,
	`strategy` text NOT NULL,
	`chosen_model_id` text,
	`runner_id` text NOT NULL,
	`model_id` text NOT NULL,
	`confidence` real NOT NULL,
	`decision_tokens` integer DEFAULT 0 NOT NULL,
	`decision_cost_usd` real,
	`rule_id` text,
	`reason` text NOT NULL,
	`at` integer NOT NULL,
	FOREIGN KEY (`task_id`) REFERENCES `tasks`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `routing_task_idx` ON `routing_decisions` (`task_id`,`at`);--> statement-breakpoint
CREATE TABLE `run_events` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`run_id` text NOT NULL,
	`seq` integer NOT NULL,
	`type` text NOT NULL,
	`payload_json` text NOT NULL,
	`at` integer NOT NULL,
	FOREIGN KEY (`run_id`) REFERENCES `runs`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `run_events_seq_idx` ON `run_events` (`run_id`,`seq`);--> statement-breakpoint
CREATE TABLE `runs` (
	`id` text PRIMARY KEY NOT NULL,
	`task_id` text NOT NULL,
	`runner_id` text NOT NULL,
	`model_id` text NOT NULL,
	`ladder_rung` integer DEFAULT 7 NOT NULL,
	`attempt` integer DEFAULT 1 NOT NULL,
	`status` text DEFAULT 'running' NOT NULL,
	`tokens_in` integer DEFAULT 0 NOT NULL,
	`tokens_out` integer DEFAULT 0 NOT NULL,
	`tokens_cache_read` integer DEFAULT 0 NOT NULL,
	`tokens_cache_write` integer DEFAULT 0 NOT NULL,
	`cost_usd` real,
	`subscription_billed` integer DEFAULT false NOT NULL,
	`cached_hit` integer DEFAULT false NOT NULL,
	`escalated_from_run_id` text,
	`session_id` text,
	`worktree_path` text,
	`started_at` integer NOT NULL,
	`ended_at` integer,
	`error_class` text,
	`error_message` text,
	FOREIGN KEY (`task_id`) REFERENCES `tasks`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `runs_task_idx` ON `runs` (`task_id`,`started_at`);--> statement-breakpoint
CREATE TABLE `savings_ledger` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`task_id` text NOT NULL,
	`task_type` text DEFAULT 'unknown' NOT NULL,
	`actual_cost_usd` real,
	`actual_subscription_usd` real,
	`baseline_cost_usd` real,
	`baseline_model_id` text,
	`baseline_subscription` integer DEFAULT false NOT NULL,
	`orchestration_cost_usd` real,
	`memory_cost_usd` real DEFAULT 0 NOT NULL,
	`net_saving_usd` real,
	`cached_hit` integer DEFAULT false NOT NULL,
	`tokens_in` integer DEFAULT 0 NOT NULL,
	`tokens_out` integer DEFAULT 0 NOT NULL,
	`at` integer NOT NULL,
	FOREIGN KEY (`task_id`) REFERENCES `tasks`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `savings_task_idx` ON `savings_ledger` (`task_id`);--> statement-breakpoint
CREATE INDEX `savings_at_idx` ON `savings_ledger` (`at`);--> statement-breakpoint
CREATE TABLE `tasks` (
	`id` text PRIMARY KEY NOT NULL,
	`context_id` text NOT NULL,
	`parent_task_id` text,
	`prompt` text NOT NULL,
	`task_type` text DEFAULT 'unknown' NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`created_at` integer NOT NULL,
	`completed_at` integer,
	FOREIGN KEY (`context_id`) REFERENCES `contexts`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `tasks_context_idx` ON `tasks` (`context_id`,`created_at`);--> statement-breakpoint
CREATE TABLE `verification_runs` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`run_id` text NOT NULL,
	`command` text NOT NULL,
	`exit_code` integer,
	`passed` integer NOT NULL,
	`output_excerpt` text NOT NULL,
	`duration_ms` integer NOT NULL,
	`at` integer NOT NULL,
	FOREIGN KEY (`run_id`) REFERENCES `runs`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `verification_run_idx` ON `verification_runs` (`run_id`);