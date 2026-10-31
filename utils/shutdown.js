const { log } = require('./logger');

function handleShutdown(close, { timeoutMs = 230000 } = {}) {
  let stopping = false;
  const stop = async signal => {
    if (stopping) return;
    stopping = true;
    log('shutdown_started', { signal });
    const timeout = setTimeout(() => { log('shutdown_timeout', {}, 'error'); process.exit(1); }, timeoutMs);
    timeout.unref();
    try { await close(); clearTimeout(timeout); process.exit(0); }
    catch (error) { log('shutdown_failed', { message: error.message }, 'error'); process.exit(1); }
  };
  process.once('SIGINT', () => stop('SIGINT'));
  process.once('SIGTERM', () => stop('SIGTERM'));
}

module.exports = { handleShutdown };
