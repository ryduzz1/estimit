import { buildApp } from './app.js';
import { config } from './config.js';
import { closeDatabase, initializeDatabase } from './database.js';

const app = buildApp();

async function shutdown(signal: string) {
  app.log.info({ signal }, 'Shutting down');
  await app.close();
  await closeDatabase();
  process.exit(0);
}

process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));

await initializeDatabase();
await app.listen({ host: config.HOST, port: config.PORT });
