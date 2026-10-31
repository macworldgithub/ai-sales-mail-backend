const { runtimeConfig } = require('../config/runtime');
try {
  const config = runtimeConfig(process.env, { requireMail: true });
  console.log(JSON.stringify({ configuration: 'valid', port: config.port, host: config.host, workerIntervalMs: config.workerIntervalMs }));
} catch (error) { console.error(error.message); process.exitCode = 1; }
