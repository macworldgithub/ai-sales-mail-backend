require('../config/runtime');
const mongoose = require('mongoose');
const connect = require('../config/db');
const User = require('../models/User');
const Template = require('../models/Template');
const template = require('../data/templates/introducing-event-transportation.json');
async function main() {
  const email = process.argv[2];
  if (!email) throw Error('Usage: node scripts/save-event-template.js ACCOUNT_EMAIL');
  try {
    await connect();
    const user = await User.findOne({ email: email.toLowerCase() });
    if (!user) throw Error('Account not found; no template was changed');
    const saved = await Template.findOneAndUpdate({ userId: user._id, templateName: template.templateName }, { $set: template, $setOnInsert: { userId: user._id } }, { new: true, upsert: true, runValidators: true });
    console.log(JSON.stringify({ saved: true, account: email, templateName: saved.templateName, id: saved._id, sendsMail: false }));
  } finally { await mongoose.disconnect(); }
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });
