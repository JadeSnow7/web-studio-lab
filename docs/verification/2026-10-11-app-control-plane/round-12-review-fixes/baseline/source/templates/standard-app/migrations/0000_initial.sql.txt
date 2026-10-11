CREATE TABLE IF NOT EXISTS records (user_id text NOT NULL, key text NOT NULL, value text NOT NULL, PRIMARY KEY (user_id, key));
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS sessions (token text PRIMARY KEY, user_id text NOT NULL, expires_at bigint NOT NULL);
