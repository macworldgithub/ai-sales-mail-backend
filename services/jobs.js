const crypto = require('node:crypto');
const nodemailer = require('nodemailer');
const { ImapFlow } = require('imapflow');
const { simpleParser } = require('mailparser');
const Campaign = require('../models/compaign');
const Reply = require('../models/automatedReplyEmail');
const FollowUp = require('../models/FollowUpEmail');
const JobLock = require('../models/JobLock');
const { mailContent } = require('../utils/email');
const { dueSchedule } = require('../utils/schedule');
const { chunkReady, inCurrentChunk, retryable, nextChunkUpdate } = require('../utils/chunks');
const { smtpFailure, mailboxHoldId, summarizeDeliveryErrors } = require('../utils/smtpFailure');
const { log } = require('../utils/logger');
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
async function deliver(transporter, campaign, recipient, template, kind, result = {}) {
  const state = kind === 'initial' ? 'deliveryStatus' : kind === 'reply' ? 'replyStatus' : 'followUpStatus';
  const query = { _id: campaign._id, recipients: { $elemMatch: { email: recipient.email, [state]: { $nin: ['sending', 'sent'] }, [`${kind}PermanentFailure`]: { $ne: true } } } };
  if (kind === 'initial') {
    if (!chunkReady(campaign) || !inCurrentChunk(campaign, campaign.recipients.findIndex(r => r.email === recipient.email))) return false;
    Object.assign(query, dueSchedule());
    if (campaign.chunkSize) {
      query.currentChunk = campaign.currentChunk || 0;
      query.$and = [{ $or: [{ nextChunkAt: null }, { nextChunkAt: { $lte: new Date() } }] }];
    }
  }
  const claimed = await Campaign.updateOne(query, { $set: { [`recipients.$.${state}`]: 'sending' } });
  if (!claimed.modifiedCount) return false;
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
    const failure = smtpFailure(error);
    log('smtp_delivery_error', { campaignId: String(campaign._id), kind, ...failure }, 'error');
    if (failure.retryAt) {
      await JobLock.updateOne({ _id: mailboxHoldId() }, {
        $max: { expiresAt: failure.retryAt },
        $set: { reason: failure.message },
      }, { upsert: true });
      result.smtpHold = { until: failure.retryAt, reason: failure.message };
    }
    await Campaign.updateOne({ _id: campaign._id, 'recipients.email': recipient.email }, {
      $set: {
        [`recipients.$.${state}`]: failure.confirmedRejected ? 'failed' : 'sending',
        [`recipients.$.${kind}PermanentFailure`]: failure.permanent,
        'recipients.$.lastError': failure.message,
        'recipients.$.lastSmtpFailure': { ...failure, at: new Date() },
      },
      ...(failure.retryAt ? {} : { $inc: { [`recipients.$.${kind}Attempts`]: 1 } }),
    });
    return true;
  }
  const now = new Date();
  const update = { $set: { [`recipients.$.${state}`]: 'sent', 'recipients.$.lastError': null } };
  if (kind === 'initial') { update.$set['recipients.$.sentAt'] = now; update.$set['recipients.$.updatedAt'] = now; update.$inc = { totalEmailSent: 1 }; }
  if (kind === 'followUp') update.$set['recipients.$.lastFollowUpAt'] = now;
  if (kind === 'reply') update.$set['recipients.$.autoReplySent'] = true;
  // A database failure after SMTP must leave "sending" for manual review, never automatic resend.
  await Campaign.updateOne({ _id: campaign._id, 'recipients.email': recipient.email }, update);
  return true;
}
async function runJobs({ transporter: providedTransport, checkInbox = checkReplies, campaignId, userId, includeAutomation = true, timeBudgetMs = 180000 } = {}) {
  const owner = crypto.randomUUID();
  const now = new Date();
  try {
    const lock = await JobLock.findOneAndUpdate({ _id: 'mail-jobs', expiresAt: { $lt: now } }, { $set: { owner, expiresAt: new Date(Date.now() + 330000) } }, { upsert: true, new: true });
    if (lock.owner !== owner) return { skipped: true };
  } catch (error) { if (error.code === 11000) return { skipped: true }; throw error; }
  const deadline = Date.now() + timeBudgetMs;
  let processed = 0;
  const errors = [];
  const result = {};
  try {
    const hold = await JobLock.findOne({ _id: mailboxHoldId(), expiresAt: { $gt: new Date() } }).lean();
    if (hold) return { processed, errors, smtpHold: { until: hold.expiresAt, reason: hold.reason } };
    const transporter = providedTransport || transport();
    if (includeAutomation) {
      try { await checkInbox(Math.min(deadline, Date.now() + 45000)); } catch { errors.push('Inbox checking failed. Check IMAP credentials and access.'); }
    }
    const eligible = [{ status: { $in: ['scheduled', 'queued', 'sending'] } }];
    if (includeAutomation) eligible.push({ hasFollowUp: true }, { isAutomatedReply: true });
    const campaigns = await Campaign.find({
      ...(campaignId ? { _id: campaignId } : {}),
      userId: userId || { $exists: true },
      $and: [dueSchedule(), { $or: eligible }],
    }).sort({ updatedAt: 1 }).limit(25);
    for (const campaign of campaigns) {
      if (Date.now() > deadline || processed >= 250) break;
      if (campaign.smtpHold?.until > new Date()) continue;
      const reply = includeAutomation && campaign.isAutomatedReply ? await Reply.findOne({ campaignId: String(campaign._id) }).sort({ updatedAt: -1 }) : null;
      const followUp = includeAutomation && campaign.hasFollowUp ? await FollowUp.findOne({ campaignId: String(campaign._id) }).sort({ updatedAt: -1 }) : null;
      let campaignProcessed = 0;
      for (const [index, recipient] of campaign.recipients.entries()) {
        if (Date.now() > deadline || processed >= 250 || campaignProcessed >= (campaign.chunkSize || 25)) break;
        let kind, template;
        if (retryable(recipient) && chunkReady(campaign) && inCurrentChunk(campaign, index)) { kind = 'initial'; template = campaign; }
        else if (recipient.deliveryStatus === 'sent' && recipient.replied && !recipient.autoReplySent && !recipient.replyPermanentFailure && recipient.replyStatus !== 'sending' && (recipient.replyAttempts || 0) < 3 && reply) { kind = 'reply'; template = reply; }
        else if (recipient.deliveryStatus === 'sent' && !recipient.replied && followUp && !recipient.followUpPermanentFailure && recipient.followUpStatus !== 'sending' && recipient.followUpStatus !== 'sent' && (recipient.followUpAttempts || 0) < 3 && new Date(recipient.sentAt).getTime() + campaign.followUpDuration * 86400000 <= Date.now()) { kind = 'followUp'; template = followUp; }
        if (kind && await deliver(transporter, campaign, recipient, template, kind, result)) { processed++; campaignProcessed++; }
        if (result.smtpHold) break;
      }
      const fresh = await Campaign.findById(campaign._id);
      const states = fresh.recipients.map(r => r.deliveryStatus);
      const status = fresh.scheduledAt && fresh.scheduledAt.getTime() > Date.now() && !fresh.totalEmailSent ? 'scheduled'
        : states.every(s => s === 'sent') ? 'sent'
        : fresh.recipients.some(retryable) ? 'sending'
        : states.includes('sending') ? 'attention' : 'failed';
      const lastDeliveryError = summarizeDeliveryErrors(fresh.recipients);
      // Do not overwrite a schedule changed after this batch read the campaign.
      await Campaign.updateOne({ _id: campaign._id, updatedAt: fresh.updatedAt }, {
        $set: { status, lastDeliveryError, smtpHold: result.smtpHold || null, lastProcessedAt: new Date(), ...nextChunkUpdate(fresh) },
      });
      if (result.smtpHold) break;
    }
    return { processed, errors, ...result };
  } finally {
    await JobLock.updateOne({ _id: 'mail-jobs', owner }, { $set: { expiresAt: new Date(0), lastRunAt: new Date() } });
  }
}
module.exports = { runJobs, deliver, transport };
