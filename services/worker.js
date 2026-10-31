const { log } = require('../utils/logger');

function createWorker({ connect, disconnect, run, intervalMs, logger = log }) {
  let stopping = false;
  let timer;
  let current;
  let connection;
  function tick() {
    if (stopping || current) return current;
    const startedAt = Date.now();
    current = (async () => {
      try {
        await connect();
        const result = await run();
        if (result.processed || result.errors?.length) logger('mail_batch_finished', result);
      } catch (error) { logger('mail_worker_error', { message: error.message, type: error.name }, 'error'); }
      finally {
        current = undefined;
        if (!stopping) timer = setTimeout(tick, Math.max(1000, intervalMs - (Date.now() - startedAt)));
      }
    })();
    return current;
  }
  return {
    async start() {
      connection ||= connect();
      await connection;
      if (!stopping) tick();
    },
    async stop() {
      stopping = true;
      clearTimeout(timer);
      await connection;
      await current;
      await disconnect();
    },
  };
}
module.exports = { createWorker };
