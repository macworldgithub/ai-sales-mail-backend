const { runtimeConfig } = require('./config/runtime');
const mongoose = require('mongoose');
const connectDB = require('./config/db');
const { log } = require('./utils/logger');
const { handleShutdown } = require('./utils/shutdown');

async function startServer(config, { app = require('./index'), connect = connectDB, disconnect = () => mongoose.disconnect() } = {}) {
  await connect();
  const server = await new Promise((resolve, reject) => {
    const instance = app.listen(config.port, config.host, () => resolve(instance));
    instance.once('error', reject);
  });
  server.requestTimeout = 300000;
  server.headersTimeout = 15000;
  server.keepAliveTimeout = 5000;
  log('api_ready', { host: config.host, port: server.address().port, release: process.env.RELEASE_ID || null });
  return {
    server,
    async stop() {
      await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
      await disconnect();
    },
  };
}

if (require.main === module) {
  Promise.resolve().then(() => startServer(runtimeConfig())).then(runtime => {
    handleShutdown(() => runtime.stop());
    if (process.send) process.send('ready');
  }).catch(error => {
    log('api_startup_failed', { message: error.message, type: error.name }, 'error');
    mongoose.disconnect().finally(() => { process.exitCode = 1; });
  });
}
module.exports = { startServer };
