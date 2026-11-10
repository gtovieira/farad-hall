// hall-api: the API (and the web UI's files when HALL_WEB_DIR is set), its migrations, its jobs.
import { buildHall } from './app.js';
import { loadConfig } from './config.js';

const config = loadConfig();
const hall = await buildHall({ config });
const stopJobs = config.jobs ? hall.startJobs() : () => {};
await hall.app.listen({ host: config.host, port: config.port });

const shutdown = async (signal: string) => {
  hall.app.log.info({ signal }, 'shutting down');
  stopJobs();
  await hall.close();
  process.exit(0);
};
process.once('SIGTERM', () => void shutdown('SIGTERM'));
process.once('SIGINT', () => void shutdown('SIGINT'));
