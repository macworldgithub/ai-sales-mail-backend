const path = require('node:path');
const root = process.env.APP_ROOT || __dirname;
const logs = process.env.APP_LOG_DIR || path.join(__dirname, 'logs');
const common = {
  cwd: root,
  interpreter: process.execPath,
  exec_mode: 'fork',
  instances: 1,
  autorestart: true,
  watch: false,
  min_uptime: '10s',
  max_restarts: 10,
  exp_backoff_restart_delay: 1000,
  wait_ready: true,
  listen_timeout: 30000,
  kill_timeout: 240000,
  merge_logs: true,
  env_production: {
    NODE_ENV: 'production',
    HOST: '127.0.0.1',
    PORT: 5921,
    TRUST_PROXY: 'loopback',
    EXTERNAL_CRON_ENABLED: 'false',
    RELEASE_ID: process.env.RELEASE_ID || 'manual',
  },
};
module.exports = { apps: [
  { ...common, name: 'ai-sales-mail-api', script: './server.js', max_memory_restart: '512M', out_file: path.join(logs, 'api-out.log'), error_file: path.join(logs, 'api-error.log') },
  { ...common, name: 'ai-sales-mail-worker', script: './worker.js', max_memory_restart: '512M', out_file: path.join(logs, 'worker-out.log'), error_file: path.join(logs, 'worker-error.log') },
] };
