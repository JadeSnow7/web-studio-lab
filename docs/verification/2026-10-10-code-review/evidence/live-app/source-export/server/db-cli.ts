import { openDatabase, migrateDatabase, seedDatabase } from './db.js';

const command = process.argv[2];
if (command !== 'migrate' && command !== 'seed') throw new Error('Expected migrate or seed');
const database = await openDatabase(process.env.WSL_DATA_DIR ?? '.data/pglite');
try {
  await migrateDatabase(database);
  if (command === 'seed') await seedDatabase(database);
  console.log(JSON.stringify({ ok: true, command }));
} finally {
  await database.client.close();
}
