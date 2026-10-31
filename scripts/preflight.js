const { runtimeConfig } = require('../config/runtime');
const mongoose = require('mongoose');
const connectDB = require('../config/db');
const { transport } = require('../services/jobs');
const { log } = require('../utils/logger');

async function preflight({
  validate = () => runtimeConfig(process.env, { requireMail: true }),
  connect = connectDB,
  getModels = () => Object.values(mongoose.models),
  createTransport = transport,
  disconnect = () => mongoose.disconnect(),
} = {}) {
  validate();
  // Register all API models before explicitly creating their declared indexes.
  require('../index');
  let smtp;
  try {
    await connect();
    for (const model of getModels()) await model.createIndexes();
    smtp = createTransport();
    await smtp.verify();
    log('deployment_preflight_passed', { database: 'connected', indexes: 'ready', smtp: 'authenticated', mailSent: false });
  } finally {
    if (smtp) smtp.close();
    await disconnect();
  }
}
if (require.main === module) preflight().catch(error => {
  log('deployment_preflight_failed', { message: error.message, type: error.name }, 'error');
  process.exitCode = 1;
});
module.exports = { preflight };
