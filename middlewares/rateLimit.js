const crypto = require('node:crypto');
const RequestLimit = require('../models/RequestLimit');
const { asyncRoute } = require('../utils/http');
// MongoDB keeps counters consistent across Vercel instances.
module.exports = (scope, maximum, windowMs) => asyncRoute(async (req, res, next) => {
  const identity = req.user?.id || req.ip;
  const bucket = Math.floor(Date.now() / windowMs);
  const id = crypto.createHash('sha256').update(`${scope}:${identity}:${bucket}`).digest('hex');
  const result = await RequestLimit.findOneAndUpdate({ _id: id }, { $inc: { count: 1 }, $setOnInsert: { expiresAt: new Date((bucket + 1) * windowMs) } }, { upsert: true, new: true });
  if (result.count > maximum) return res.set('Retry-After', String(Math.ceil(((bucket + 1) * windowMs - Date.now()) / 1000))).status(429).json({ message: 'Too many requests. Please try again later.' });
  next();
});
