const mongoose = require('mongoose');
mongoose.set('bufferCommands', false);
let connectionPromise;
module.exports = async function connectDB() {
  if (mongoose.connection.readyState === 1) return mongoose;
  if (!process.env.MONGO_URI) throw new Error('MONGO_URI is required');
  if (!connectionPromise) connectionPromise = mongoose.connect(process.env.MONGO_URI, { serverSelectionTimeoutMS: 8000, maxPoolSize: 5, autoIndex: process.env.NODE_ENV !== 'production' })
    .then(connection => { connectionPromise = undefined; return connection; }, error => { connectionPromise = undefined; throw error; });
  return connectionPromise;
};
