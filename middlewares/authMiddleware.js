const jwt = require('jsonwebtoken');
const mongoose = require('mongoose');
module.exports = (req, res, next) => {
  if (!process.env.JWT_SECRET) return res.status(503).json({ message: 'Authentication is not configured' });
  const token = req.get('Authorization')?.replace(/^Bearer\s+/i, '');
  try {
    const decoded = jwt.verify(token || '', process.env.JWT_SECRET, { algorithms: ['HS256'] });
    if (!mongoose.isObjectIdOrHexString(decoded.id)) throw new Error('Invalid user');
    req.user = { id: decoded.id }; next();
  } catch { res.status(401).json({ message: 'Your session has expired. Please log in again.' }); }
};
