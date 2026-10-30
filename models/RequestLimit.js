const mongoose = require('mongoose');
module.exports = mongoose.model('RequestLimit', new mongoose.Schema({
  _id: String,
  count: { type: Number, default: 0 },
  expiresAt: { type: Date, expires: 0 },
}));
