import { pgTable, text, primaryKey, bigint } from 'drizzle-orm/pg-core';

export const records = pgTable(
  'records',
  {
    userId: text('user_id').notNull(),
    key: text('key').notNull(),
    value: text('value').notNull(),
  },
  (table) => [primaryKey({ columns: [table.userId, table.key] })],
);
export const sessions = pgTable('sessions', {
  token: text('token').primaryKey(),
  userId: text('user_id').notNull(),
  expiresAt: bigint('expires_at', { mode: 'number' }).notNull(),
});
