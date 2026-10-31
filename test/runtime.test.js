const { test } = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const { runtimeConfig } = require('../config/runtime');
const { startServer } = require('../server');
const { createWorker } = require('../services/worker');
const { preflight } = require('../scripts/preflight');

const environment = {
  NODE_ENV: 'production', MONGO_URI: 'mongodb://127.0.0.1/test-runtime',
  JWT_SECRET: 'a'.repeat(40), TRACKING_SECRET: 'b'.repeat(40), CRON_SECRET: 'c'.repeat(40),
  SERVER_URL: 'https://ai-sales-backend.omnisuiteai.com', FRONTEND_URL: 'https://ai-sales-mail-frontend.vercel.app',
  EMAIL_USER: 'sender@example.com', EMAIL_PASS: 'test-only',
};

test('production configuration validates dependencies and distinct secrets without exposing them', () => {
  const config = runtimeConfig(environment, { requireMail: true });
  assert.equal(config.port, 5921); assert.equal(config.host, '127.0.0.1'); assert.equal(config.workerIntervalMs, 60000);
  for (const change of [
    { MONGO_URI: '' }, { MONGO_URI: 'https://invalid.example' }, { JWT_SECRET: 'short' },
    { TRACKING_SECRET: environment.JWT_SECRET }, { SERVER_URL: 'http://api.example.com' },
    { FRONTEND_URL: 'https://app.example.com/path' }, { PORT: '0' }, { PORT: '5921abc' },
    { WORKER_INTERVAL_MS: '0' }, { EMAIL_PASS: '' }, { SERVER_URL: 'https://user:password@api.example.com' },
  ]) assert.throws(() => runtimeConfig({ ...environment, ...change }, { requireMail: true }), { name: 'ConfigurationError' });
});

test('API waits for the database before listening and drains active requests before disconnecting', async () => {
  const app = express();
  let completeRequest;
  let connected = false;
  let disconnected = false;
  let entered;
  const started = new Promise(resolve => { entered = resolve; });
  app.get('/slow', (_req, res) => { assert.equal(connected, true); completeRequest = () => res.json({ ok: true }); entered(); });
  const runtime = await startServer({ host: '127.0.0.1', port: 0 }, {
    app, connect: async () => { connected = true; }, disconnect: async () => { disconnected = true; },
  });
  const response = fetch(`http://127.0.0.1:${runtime.server.address().port}/slow`);
  await started;
  const stopping = runtime.stop();
  assert.equal(disconnected, false);
  completeRequest();
  assert.equal((await response).status, 200);
  await stopping;
  assert.equal(disconnected, true);
});

test('worker shutdown waits for the active batch and does not start another batch', async () => {
  let finish;
  let entered;
  let disconnected = false;
  let runs = 0;
  const started = new Promise(resolve => { entered = resolve; });
  const worker = createWorker({
    connect: async () => {}, disconnect: async () => { disconnected = true; }, intervalMs: 10,
    run: async () => { runs++; entered(); await new Promise(resolve => { finish = resolve; }); return { processed: 1, errors: [] }; },
    logger: () => {},
  });
  await worker.start(); await started;
  const stopping = worker.stop();
  assert.equal(disconnected, false);
  finish(); await stopping;
  await new Promise(resolve => setTimeout(resolve, 50));
  assert.equal(disconnected, true); assert.equal(runs, 1);
});

test('worker survives a failed batch and continues polling without overlapping work', async () => {
  let runs = 0;
  let active = 0;
  let maximumActive = 0;
  let second;
  const ranTwice = new Promise(resolve => { second = resolve; });
  const worker = createWorker({
    connect: async () => {}, disconnect: async () => {}, intervalMs: 10, logger: () => {},
    run: async () => {
      active++; maximumActive = Math.max(active, maximumActive); runs++;
      try { if (runs === 1) throw new Error('Temporary failure'); second(); return { processed: 0, errors: [] }; }
      finally { active--; }
    },
  });
  await worker.start(); await ranTwice; await worker.stop();
  assert.equal(runs, 2); assert.equal(maximumActive, 1);
});

test('deployment preflight checks indexes and SMTP authentication without sending mail', async () => {
  const calls = [];
  await preflight({
    validate: () => calls.push('configuration'), connect: async () => calls.push('connect'),
    getModels: () => [{ createIndexes: async () => calls.push('indexes') }],
    createTransport: () => ({ verify: async () => calls.push('verify'), close: () => calls.push('close'), sendMail: () => { throw new Error('Preflight must not send mail'); } }),
    disconnect: async () => calls.push('disconnect'),
  });
  assert.deepEqual(calls, ['configuration', 'connect', 'indexes', 'verify', 'close', 'disconnect']);
});

test('deployment preflight releases resources when SMTP authentication fails', async () => {
  const calls = [];
  await assert.rejects(preflight({
    validate: () => {}, connect: async () => {}, getModels: () => [],
    createTransport: () => ({ verify: async () => { throw new Error('Authentication failed'); }, close: () => calls.push('close') }),
    disconnect: async () => calls.push('disconnect'),
  }), /Authentication failed/);
  assert.deepEqual(calls, ['close', 'disconnect']);
});
