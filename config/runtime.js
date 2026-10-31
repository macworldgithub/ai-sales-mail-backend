const path = require('node:path');
require('dotenv').config({ path: process.env.APP_ENV_FILE || path.join(__dirname, '..', '.env') });

function configurationError(message) {
  const error = new Error(message);
  error.name = 'ConfigurationError';
  throw error;
}

function runtimeConfig(env = process.env, { requireMail = false } = {}) {
  const required = ['MONGO_URI', 'JWT_SECRET', 'TRACKING_SECRET', 'CRON_SECRET', 'SERVER_URL', 'FRONTEND_URL'];
  if (requireMail) required.push('EMAIL_USER', 'EMAIL_PASS');
  const missing = required.filter(key => typeof env[key] !== 'string' || !env[key].trim() || env[key].startsWith('replace-'));
  if (missing.length) configurationError(`Configure these environment variables: ${missing.join(', ')}`);
  if (!/^mongodb(?:\+srv)?:\/\//.test(env.MONGO_URI)) configurationError('MONGO_URI must be a MongoDB connection string');
  if (env.NODE_ENV === 'production') {
    for (const key of ['JWT_SECRET', 'TRACKING_SECRET', 'CRON_SECRET']) {
      if (env[key].length < 32) configurationError(`${key} must contain at least 32 characters in production`);
    }
    if (new Set(['JWT_SECRET', 'TRACKING_SECRET', 'CRON_SECRET'].map(key => env[key])).size !== 3) configurationError('Use distinct JWT_SECRET, TRACKING_SECRET, and CRON_SECRET values');
  }
  for (const [key, value] of [['SERVER_URL', env.SERVER_URL], ...env.FRONTEND_URL.split(',').map(value => ['FRONTEND_URL', value.trim()])]) {
    let url;
    try { url = new URL(value); } catch { configurationError(`${key} must be an HTTP(S) origin`); }
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash || url.pathname !== '/') configurationError(`${key} must be an HTTP(S) origin without a path or credentials`);
    if (env.NODE_ENV === 'production' && url.protocol !== 'https:') configurationError(`${key} must use HTTPS in production`);
  }
  const port = Number(env.PORT || 5921);
  if (!Number.isInteger(port) || port < 1 || port > 65535) configurationError('PORT must be between 1 and 65535');
  const workerIntervalMs = Number(env.WORKER_INTERVAL_MS || 60000);
  if (!Number.isInteger(workerIntervalMs) || workerIntervalMs < 5000 || workerIntervalMs > 3600000) configurationError('WORKER_INTERVAL_MS must be between 5000 and 3600000');
  if (requireMail) {
    const smtpPort = Number(env.SMTP_PORT || 465);
    if (!Number.isInteger(smtpPort) || smtpPort < 1 || smtpPort > 65535) configurationError('SMTP_PORT must be a valid port number');
  }
  return { port, host: env.HOST || '127.0.0.1', workerIntervalMs };
}

module.exports = { runtimeConfig };
