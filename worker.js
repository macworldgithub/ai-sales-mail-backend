const { runtimeConfig } = require('./config/runtime');
const mongoose = require('mongoose');
const connectDB = require('./config/db');
const { runJobs } = require('./services/jobs');
const { createWorker } = require('./services/worker');
const { log } = require('./utils/logger');
const { handleShutdown } = require('./utils/shutdown');

async function main() {
  const config = runtimeConfig(process.env, { requireMail: true });
  const worker = createWorker({ connect: connectDB, disconnect: () => mongoose.disconnect(), run: runJobs, intervalMs: config.workerIntervalMs });
  handleShutdown(() => worker.stop());
  await worker.start();
  log('worker_ready', { intervalMs: config.workerIntervalMs, release: process.env.RELEASE_ID || null });
  if (process.send) process.send('ready');
}
if (require.main === module) main().catch(error => {
  log('worker_startup_failed', { message: error.message, type: error.name }, 'error');
  mongoose.disconnect().finally(() => { process.exitCode = 1; });
});
module.exports = { main };
