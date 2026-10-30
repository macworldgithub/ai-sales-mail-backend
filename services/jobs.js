const crypto = require('node:crypto');
const nodemailer = require('nodemailer');
const { ImapFlow } = require('imapflow');
const { simpleParser } = require('mailparser');
const Campaign = require('../models/compaign');
const Reply = require('../models/automatedReplyEmail');
const FollowUp = require('../models/FollowUpEmail');
const JobLock = require('../models/JobLock');
const { mailContent } = require('../utils/email');
function transport() {
  if (!process.env.EMAIL_USER || !process.env.EMAIL_PASS || !process.env.TRACKING_SECRET || !process.env.SERVER_URL) throw new Error('Email delivery is not configured');
  return nodemailer.createTransport({
    host: process.env.SMTP_HOST || 'smtp.gmail.com', port: Number(process.env.SMTP_PORT || 465),
    secure: (process.env.SMTP_PORT || '465') === '465',
    requireTLS: true,
    auth: { user: process.env.EMAIL_USER, pass: process.env.EMAIL_PASS },
    connectionTimeout: 10000, greetingTimeout: 10000, socketTimeout: 15000,
  });
}
async function checkReplies(deadline) {
  const connection = new ImapFlow({
    host: process.env.IMAP_HOST || 'imap.gmail.com', port: 993, secure: true,
    auth: { user: process.env.EMAIL_USER, pass: process.env.EMAIL_PASS },
    connectionTimeout: 10000, greetingTimeout: 10000, socketTimeout: 15000,
    maxLiteralSize: 2 * 1024 * 1024, logger: false, disableAutoIdle: true,
  });
  connection.on('error', () => {});
  try {
    await connection.connect();
    await connection.mailboxOpen('INBOX');
    const since = new Date(Date.now() - 30 * 86400000);
    const messages = await connection.search({ seen: false, since }, { uid: true }) || [];
    for (const item of messages.slice(-50)) {
      if (Date.now() > deadline) break;
      const raw = await connection.fetchOne(item, { headers: ['from', 'in-reply-to', 'references', 'message-id', 'auto-submitted'] }, { uid: true });
      if (!raw?.headers) continue;
      const parsed = await simpleParser(raw.headers);
      if (parsed.headers.get('auto-submitted') && parsed.headers.get('auto-submitted') !== 'no') continue;
      const sender = parsed.from?.value?.[0]?.address?.toLowerCase();
      const references = [parsed.inReplyTo, ...([parsed.references].flat().filter(Boolean))].filter(Boolean);
      if (!sender || sender === process.env.EMAIL_USER.toLowerCase() || !references.length) continue;
      const campaign = await Campaign.findOne({ recipients: { $elemMatch: { email: sender, messageId: { $in: references } } } });
      if (!campaign) continue;
      await Campaign.updateOne({ _id: campaign._id, recipients: { $elemMatch: { email: sender, replied: 0 } } }, {
        $set: { 'recipients.$.replied': 1, 'recipients.$.replyMessageId': parsed.messageId }, $inc: { totalEmailReplied: 1 },
      });
      await connection.messageFlagsAdd(item, ['\\Seen'], { uid: true });
    }
  } finally { connection.close(); }
}
async function deliver(transporter, campaign, recipient, template, kind) {
  const state = kind === 'initial' ? 'deliveryStatus' : kind === 'reply' ? 'replyStatus' : 'followUpStatus';
  const query = { _id: campaign._id, recipients: { $elemMatch: { email: recipient.email, [state]: { $nin: ['sending', 'sent'] } } } };
  const claimed = await Campaign.updateOne(query, { $set: { [`recipients.$.${state}`]: 'sending' } });
  if (!claimed.modifiedCount) return;
  const messageId = `<${campaign._id}.${crypto.randomUUID()}@${new URL(process.env.SERVER_URL).hostname}>`;
  // Store the message ID before SMTP so reply matching survives an interrupted request.
  if (kind === 'initial') await Campaign.updateOne({ _id: campaign._id, 'recipients.email': recipient.email }, { $set: { 'recipients.$.messageId': messageId } });
  let info;
  try {
    info = await transporter.sendMail({
      from: process.env.EMAIL_USER, to: recipient.email, messageId,
      ...(kind === 'reply' ? { headers: { 'Auto-Submitted': 'auto-replied' } } : {}),
      ...mailContent(template, recipient, campaign._id),
      ...(kind === 'reply' && recipient.replyMessageId ? { inReplyTo: recipient.replyMessageId, references: [recipient.messageId, recipient.replyMessageId] } : {}),
    });
    if (info.rejected?.length) { const error = new Error('Recipient rejected by mail server'); error.responseCode = 550; throw error; }
  } catch (error) {
    const safeToRetry = error.responseCode >= 400 || ['EDNS', 'ECONNECTION', 'EAUTH'].includes(error.code);
    await Campaign.updateOne({ _id: campaign._id, 'recipients.email': recipient.email }, {
      $set: { [`recipients.$.${state}`]: safeToRetry ? 'failed' : 'sending', 'recipients.$.lastError': safeToRetry ? 'Mail delivery failed' : 'Delivery outcome is uncertain. Review the sender mailbox before retrying.' },
      $inc: { [`recipients.$.${kind}Attempts`]: 1 },
    });
    return;
  }
  const now = new Date();
  const update = { $set: { [`recipients.$.${state}`]: 'sent', 'recipients.$.lastError': null } };
  if (kind === 'initial') { update.$set['recipients.$.sentAt'] = now; update.$set['recipients.$.updatedAt'] = now; update.$inc = { totalEmailSent: 1 }; }
  if (kind === 'followUp') update.$set['recipients.$.lastFollowUpAt'] = now;
  if (kind === 'reply') update.$set['recipients.$.autoReplySent'] = true;
  // A database failure after SMTP must leave "sending" for manual review, never automatic resend.
  await Campaign.updateOne({ _id: campaign._id, 'recipients.email': recipient.email }, update);
}
async function runJobs({ transporter: providedTransport, checkInbox = checkReplies } = {}) {
  const owner = crypto.randomUUID();
  const now = new Date();
  try {
    const lock = await JobLock.findOneAndUpdate({ _id: 'mail-jobs', expiresAt: { $lt: now } }, { $set: { owner, expiresAt: new Date(Date.now() + 330000) } }, { upsert: true, new: true });
    if (lock.owner !== owner) return { skipped: true };
  } catch (error) { if (error.code === 11000) return { skipped: true }; throw error; }
  const deadline = Date.now() + 180000;
  let processed = 0;
  const errors = [];
  try {
    const transporter = providedTransport || transport();
    try { await checkInbox(Math.min(deadline, Date.now() + 45000)); } catch { errors.push('Inbox checking failed. Check IMAP credentials and access.'); }
    const campaigns = await Campaign.find({ userId: { $exists: true }, $or: [{ status: { $in: ['queued', 'sending'] } }, { hasFollowUp: true }, { isAutomatedReply: true }] }).sort({ updatedAt: 1 }).limit(25);
    for (const campaign of campaigns) {
      if (Date.now() > deadline || processed >= 25) break;
      const reply = campaign.isAutomatedReply ? await Reply.findOne({ campaignId: String(campaign._id) }).sort({ updatedAt: -1 }) : null;
      const followUp = campaign.hasFollowUp ? await FollowUp.findOne({ campaignId: String(campaign._id) }).sort({ updatedAt: -1 }) : null;
      for (const recipient of campaign.recipients) {
        if (Date.now() > deadline || processed >= 25) break;
        let kind, template;
        if (['pending', 'failed'].includes(recipient.deliveryStatus) && (recipient.initialAttempts || 0) < 3) { kind = 'initial'; template = campaign; }
        else if (recipient.deliveryStatus === 'sent' && recipient.replied && !recipient.autoReplySent && recipient.replyStatus !== 'sending' && (recipient.replyAttempts || 0) < 3 && reply) { kind = 'reply'; template = reply; }
        else if (recipient.deliveryStatus === 'sent' && !recipient.replied && followUp && recipient.followUpStatus !== 'sending' && recipient.followUpStatus !== 'sent' && (recipient.followUpAttempts || 0) < 3 && new Date(recipient.sentAt).getTime() + campaign.followUpDuration * 86400000 <= Date.now()) { kind = 'followUp'; template = followUp; }
        if (kind) { await deliver(transporter, campaign, recipient, template, kind); processed++; }
      }
      const fresh = await Campaign.findById(campaign._id);
      const states = fresh.recipients.map(r => r.deliveryStatus);
      const status = states.every(s => s === 'sent') ? 'sent'
        : fresh.recipients.some(r => ['pending', 'failed'].includes(r.deliveryStatus) && (r.initialAttempts || 0) < 3) ? 'sending'
        : states.includes('sending') ? 'attention' : 'failed';
      await Campaign.updateOne({ _id: campaign._id }, { $set: { status } });
    }
    return { processed, errors };
  } finally {
    await JobLock.updateOne({ _id: 'mail-jobs', owner }, { $set: { expiresAt: new Date(0) } });
  }
}
module.exports = { runJobs, deliver };
