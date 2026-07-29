CREATE TABLE `memory_ops` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`task_id` text NOT NULL,
	`provider` text NOT NULL,
	`kind` text NOT NULL,
	`scope` text NOT NULL,
	`items` integer DEFAULT 0 NOT NULL,
	`tokens` integer DEFAULT 0 NOT NULL,
	`cost_usd` real,
	`ok` integer DEFAULT true NOT NULL,
	`detail` text,
	`at` integer NOT NULL,
	FOREIGN KEY (`task_id`) REFERENCES `tasks`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `memory_ops_task_idx` ON `memory_ops` (`task_id`,`at`);--> statement-breakpoint
PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_savings_ledger` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`task_id` text NOT NULL,
	`task_type` text DEFAULT 'unknown' NOT NULL,
	`actual_cost_usd` real,
	`actual_subscription_usd` real,
	`baseline_cost_usd` real,
	`baseline_model_id` text,
	`baseline_subscription` integer DEFAULT false NOT NULL,
	`orchestration_cost_usd` real,
	`memory_cost_usd` real,
	`net_saving_usd` real,
	`cached_hit` integer DEFAULT false NOT NULL,
	`tokens_in` integer DEFAULT 0 NOT NULL,
	`tokens_out` integer DEFAULT 0 NOT NULL,
	`at` integer NOT NULL,
	FOREIGN KEY (`task_id`) REFERENCES `tasks`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
INSERT INTO `__new_savings_ledger`("id", "task_id", "task_type", "actual_cost_usd", "actual_subscription_usd", "baseline_cost_usd", "baseline_model_id", "baseline_subscription", "orchestration_cost_usd", "memory_cost_usd", "net_saving_usd", "cached_hit", "tokens_in", "tokens_out", "at") SELECT "id", "task_id", "task_type", "actual_cost_usd", "actual_subscription_usd", "baseline_cost_usd", "baseline_model_id", "baseline_subscription", "orchestration_cost_usd", "memory_cost_usd", "net_saving_usd", "cached_hit", "tokens_in", "tokens_out", "at" FROM `savings_ledger`;--> statement-breakpoint
DROP TABLE `savings_ledger`;--> statement-breakpoint
ALTER TABLE `__new_savings_ledger` RENAME TO `savings_ledger`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE UNIQUE INDEX `savings_task_idx` ON `savings_ledger` (`task_id`);--> statement-breakpoint
CREATE INDEX `savings_at_idx` ON `savings_ledger` (`at`);--> statement-breakpoint
ALTER TABLE `contexts` ADD `memory_scope` text;--> statement-breakpoint
ALTER TABLE `contexts` ADD `memory_enabled` integer DEFAULT true NOT NULL;