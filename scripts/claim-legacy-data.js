require('dotenv').config();
const mongoose = require('mongoose');
const connectDB = require('../config/db');
const User = require('../models/User');
const Campaign = require('../models/compaign');
const Template = require('../models/Template');
async function main() {
  const index = process.argv.indexOf('--user-email');
  const email = process.argv[index + 1];
  if (index < 0 || !email || email.startsWith('--')) throw new Error('Usage: node scripts/claim-legacy-data.js --user-email owner@example.com [--apply]');
  await connectDB();
  const user = await User.findOne({ email: email.trim().toLowerCase() });
  if (!user) throw new Error('Create the owner account first');
  const filter = { $or: [{ userId: { $exists: false } }, { userId: null }] };
  const [campaigns, templates] = await Promise.all([Campaign.countDocuments(filter), Template.countDocuments(filter)]);
  console.log(JSON.stringify({ owner: user.email, unownedCampaigns: campaigns, unownedTemplates: templates, apply: process.argv.includes('--apply') }, null, 2));
  if (!process.argv.includes('--apply')) return;
  // Only run for a single-owner legacy database after confirming the dry-run counts.
  await Template.updateMany(filter, { $set: { userId: user._id } });
  for await (const campaign of Campaign.find(filter).cursor()) {
    const recipients = campaign.recipients.map(recipient => {
      const { email, opened, replied, sentAt, updatedAt, data, ...other } = recipient;
      return { data: data || other, email: String(email).toLowerCase(), opened: opened > 0 ? 1 : 0, replied: replied > 0 ? 1 : 0, sentAt: sentAt || campaign.createdAt, updatedAt: updatedAt || campaign.createdAt, deliveryStatus: 'sent', autoReplySent: false };
    });
    await Campaign.updateOne({ _id: campaign._id, ...filter }, { $set: { userId: user._id, recipients, status: 'sent', totalEmailSent: recipients.length, totalEmailOpened: recipients.filter(r => r.opened).length, totalEmailReplied: recipients.filter(r => r.replied).length } });
  }
  console.log('Legacy data assigned.');
}
main().catch(error => { console.error(error.message); process.exitCode = 1; }).finally(() => mongoose.disconnect());
