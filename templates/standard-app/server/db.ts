import { mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { migrate } from 'drizzle-orm/pglite/migrator';
import { records } from './schema.js';

export async function openDatabase(dataDir: string) {
  const directory = resolve(dataDir);
  await mkdir(directory, { recursive: true });
  const client = new PGlite(directory);
  await client.waitReady;
  return { client, db: drizzle(client) };
}
export type Database = Awaited<ReturnType<typeof openDatabase>>;
export async function migrateDatabase(database: Database) {
  await migrate(database.db, { migrationsFolder: resolve('migrations') });
}
export async function seedDatabase(database: Database) {
  await database.db
    .insert(records)
    .values([
      { userId: 'A', key: 'welcome', value: 'Ready' },
      { userId: 'B', key: 'welcome', value: 'Ready' },
    ])
    .onConflictDoNothing();
}
