function log(event, details = {}, level = 'info') {
  const record = JSON.stringify({ time: new Date().toISOString(), level, event, ...details });
  const secrets = ['MONGO_URI', 'JWT_SECRET', 'TRACKING_SECRET', 'CRON_SECRET', 'EMAIL_PASS', 'AI_API_KEY'].map(key => process.env[key]).filter(value => value && value.length >= 8);
  const safe = secrets.reduce((value, secret) => value.split(secret).join('[redacted]'), record)
    .replace(/(mongodb(?:\+srv)?:\/\/)[^@\s"]+@/g, '$1[redacted]@');
  (level === 'error' ? console.error : console.log)(safe);
}
module.exports = { log };
