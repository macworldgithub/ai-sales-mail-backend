require('./config/runtime');
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const connectDB = require('./config/db');
const mongoose = require('mongoose');
const { log } = require('./utils/logger');
const app = express();
app.disable('x-powered-by');
app.set('trust proxy', process.env.TRUST_PROXY || (process.env.VERCEL ? 1 : 'loopback'));
app.use(helmet());
const origins = (process.env.FRONTEND_URL || 'https://ai-sales-mail-frontend.vercel.app').split(',').map(value => value.trim().replace(/\/$/, ''));
app.use(cors({ origin(origin, callback) {
  if (!origin || origins.includes(origin)) return callback(null, true);
  const error = new Error('Origin is not allowed'); error.status = 403; callback(error);
} }));
app.use(express.json({ limit: '2mb' }));
app.use('/email/assets', express.static(require('node:path').join(__dirname, 'assets', 'email'), { maxAge: '1d', setHeaders(res) { res.set('Cross-Origin-Resource-Policy', 'cross-origin'); } }));
app.get('/', (_req, res) => res.json({ message: 'AI SalesMail API is running' }));
app.get('/health', (_req, res) => res.set('Cache-Control', 'no-store').json({ status: 'ok' }));
app.get('/ready', (_req, res) => res.set('Cache-Control', 'no-store').status(mongoose.connection.readyState === 1 ? 200 : 503).json({
  status: mongoose.connection.readyState === 1 ? 'ready' : 'unavailable',
  database: mongoose.connection.readyState === 1 ? 'connected' : 'disconnected',
  release: process.env.RELEASE_ID || null,
}));
app.get('/api/cron/status', async (req, res, next) => {
  if (!process.env.CRON_SECRET || req.get('Authorization') !== `Bearer ${process.env.CRON_SECRET}`) return res.status(401).json({ message: 'Unauthorized' });
  try {
    await connectDB();
    const lock = await require('./models/JobLock').findById('mail-jobs');
    res.json({ status: 'ok', lastRunAt: lock?.lastRunAt || null, running: !!lock && lock.expiresAt > new Date() });
  } catch (error) { next(error); }
});
app.get('/api/cron/process', async (req, res, next) => {
  if (!process.env.CRON_SECRET || req.get('Authorization') !== `Bearer ${process.env.CRON_SECRET}`) return res.status(401).json({ message: 'Unauthorized' });
  if (!process.env.VERCEL && process.env.EXTERNAL_CRON_ENABLED !== 'true') return res.status(409).json({ message: 'External cron is disabled. The PM2 worker processes mail automatically.' });
  try { await connectDB(); res.json(await require('./services/jobs').runJobs()); } catch (error) { next(error); }
});
app.use(async (_req, res, next) => {
  try { await connectDB(); next(); } catch { res.status(503).json({ message: 'Database is unavailable. Check the server configuration.' }); }
});
app.use('/api/auth', require('./middlewares/rateLimit')('auth', 30, 600000), require('./routers/authRoutes'));
app.use('/email', require('./routers/emailRoutes'));
app.use('/templates', require('./routers/templateRoutes'));
app.use('/campaigns', require('./routers/compaignRoutes'));
app.use('/automated-reply', require('./routers/AutomatedReply'));
app.use('/follow-up', require('./routers/FollowUpRoutes'));
app.use((_req, res) => res.status(404).json({ message: 'Route not found' }));
app.use((error, _req, res, _next) => {
  const status = error.status || (error.name === 'ValidationError' || error.name === 'CastError' ? 400 : error.code === 11000 ? 409 : 500);
  if (status >= 500) log('request_failed', { type: error.name, message: error.message }, 'error');
  res.status(status).json({ message: error.code === 11000 ? 'A record with these details already exists' : status >= 500 && !error.expose ? 'The request could not be completed. Please try again.' : error.message });
});
module.exports = app;
