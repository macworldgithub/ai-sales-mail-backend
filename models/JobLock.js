const mongoose = require('mongoose');
module.exports = mongoose.model('JobLock', new mongoose.Schema({ _id: String, expiresAt: Date, owner: String, lastRunAt: Date }));
