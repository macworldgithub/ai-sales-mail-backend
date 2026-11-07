const Campaign = require('../models/compaign');
const JobLock = require('../models/JobLock');
const { asyncRoute, fail, text, objectId, emailFields } = require('../utils/http');
const { normalizeRecipients } = require('../utils/email');
const { parseSchedule } = require('../utils/schedule');
const { parseChunks, chunkReady } = require('../utils/chunks');
const { mailboxHoldId, summarizeDeliveryErrors, LEGACY_REJECTION } = require('../utils/smtpFailure');
const retryStatuses = ['failed', 'attention'];
const rejectedRecipients = {
  deliveryStatus: 'failed',
  initialPermanentFailure: { $ne: true },
  $or: [{ 'lastSmtpFailure.confirmedRejected': true }, { lastError: LEGACY_REJECTION }],
};
exports.createCampaign = asyncRoute(async (req, res) => {
  if (!process.env.EMAIL_USER || !process.env.EMAIL_PASS || !process.env.SERVER_URL || !process.env.TRACKING_SECRET) fail(503, 'Email delivery is not configured');
  const requestId = req.get('Idempotency-Key');
  if (requestId && !/^[a-zA-Z0-9-]{16,80}$/.test(requestId)) fail(400, 'Invalid idempotency key');
  if (requestId) {
    const existing = await Campaign.findOne({ userId: req.user.id, requestId });
    if (existing) return res.status(200).json({ message: 'Campaign already queued', campaign: existing });
  }
  const scheduledAt = parseSchedule(req.body.scheduledAt);
  let campaign;
  try { campaign = await Campaign.create({
    userId: req.user.id, campaignName: text(req.body.campaignName, 'Campaign name', 200),
    ...(requestId ? { requestId } : {}),
    description: text(req.body.description, 'Description', 2000), ...emailFields(req.body),
    ...parseChunks(req.body),
    recipients: normalizeRecipients(req.body.recipients),
    scheduledAt, status: scheduledAt ? 'scheduled' : 'queued', totalEmailSent: 0, totalEmailOpened: 0, totalEmailReplied: 0,
  }); } catch (error) {
    if (error.code !== 11000 || !requestId) throw error;
    campaign = await Campaign.findOne({ userId: req.user.id, requestId });
    if (!campaign) throw error;
  }
  res.status(201).json({ message: scheduledAt ? 'Campaign scheduled' : 'Campaign queued for delivery', campaign });
});
exports.updateSchedule = asyncRoute(async (req, res) => {
  if (!Object.hasOwn(req.body, 'scheduledAt')) fail(400, 'Provide a send time, or null to send now');
  const id = objectId(req.params.id);
  const scheduledAt = parseSchedule(req.body.scheduledAt);
  const campaign = await Campaign.findOneAndUpdate({
    _id: id, userId: req.user.id, totalEmailSent: 0,
    status: { $in: ['queued', 'scheduled'] },
    recipients: { $not: { $elemMatch: { deliveryStatus: { $in: ['sending', 'sent'] } } } },
  }, { $set: { scheduledAt, status: scheduledAt ? 'scheduled' : 'queued' } }, { new: true });
  if (!campaign) {
    if (!await Campaign.exists({ _id: id, userId: req.user.id })) fail(404, 'Campaign not found');
    fail(409, 'The send time cannot change after delivery has started');
  }
  res.json({ message: scheduledAt ? 'Send time updated' : 'Campaign ready to send', campaign });
});
exports.processCampaign = asyncRoute(async (req, res) => {
  const id = objectId(req.params.id);
  const campaign = await Campaign.findOne({ _id: id, userId: req.user.id });
  if (!campaign) fail(404, 'Campaign not found');
  if (campaign.scheduledAt && campaign.scheduledAt.getTime() > Date.now()) fail(409, 'This campaign is scheduled for a future time. Change its send time first.');
  if (campaign.smtpHold?.until > new Date()) return res.status(202).json({ smtpHold: campaign.smtpHold, message: campaign.smtpHold.reason });
  if (!chunkReady(campaign)) return res.status(202).json({ campaign, message: `The next chunk is scheduled for ${campaign.nextChunkAt.toISOString()}.` });
  const result = await require('../services/jobs').runJobs({ campaignId: id, userId: req.user.id, includeAutomation: false, timeBudgetMs: 40000 });
  const updated = await Campaign.findOne({ _id: id, userId: req.user.id }).select('-recipients -emailTemplateBody -emailTemplateClosing');
  if (result.smtpHold) return res.status(202).json({ ...result, campaign: updated, message: result.smtpHold.reason });
  res.status(result.skipped ? 202 : 200).json({ ...result, campaign: updated, message: result.skipped ? 'The delivery worker is busy. Your campaign remains queued.' : updated.lastDeliveryError || (updated.status === 'sent' ? 'Campaign sent' : updated.nextChunkAt && updated.nextChunkAt > new Date() ? `Next chunk: ${updated.nextChunkAt.toISOString()}` : 'Delivery batch processed; remaining recipients stay queued') });
});
exports.retryRejected = asyncRoute(async (req, res) => {
  const filter = { _id: objectId(req.params.id), userId: req.user.id };
  const campaign = await Campaign.findOne(filter).lean();
  if (!campaign) fail(404, 'Campaign not found');
  if (!retryStatuses.includes(campaign.status)) fail(409, 'The campaign already has active delivery.');
  if (campaign.smtpHold?.until > new Date() || await JobLock.exists({ _id: mailboxHoldId(), expiresAt: { $gt: new Date() } })) {
    fail(409, 'SMTP sending is paused. Retry after the pause ends.');
  }

  const rejected = campaign.recipients.flatMap((recipient, index) =>
    recipient.deliveryStatus === 'failed' && !recipient.initialPermanentFailure &&
    (recipient.lastSmtpFailure?.confirmedRejected || recipient.lastError === LEGACY_REJECTION) ? [index] : []);
  if (!rejected.length) fail(409, 'There are no confirmed rejections eligible for retry.');

  const set = {
    status: 'queued',
    nextChunkAt: null,
    currentChunk: campaign.chunkSize ? Math.floor(rejected[0] / campaign.chunkSize) : 0,
  };
  const retried = new Set(rejected);
  set.lastDeliveryError = summarizeDeliveryErrors(campaign.recipients.filter((_, i) => !retried.has(i)));
  for (const index of rejected) {
    set[`recipients.${index}.deliveryStatus`] = 'pending';
    set[`recipients.${index}.initialAttempts`] = 0;
    set[`recipients.${index}.lastError`] = null;
  }
  const updated = await Campaign.updateOne({ ...filter, status: campaign.status, updatedAt: campaign.updatedAt }, { $set: set });
  if (!updated.modifiedCount) fail(409, 'Campaign changed. Refresh it and try again.');
  res.status(202).json({ queued: rejected.length, message: `Queued ${rejected.length} rejected messages for retry.` });
});
exports.getAllCampaigns = asyncRoute(async (req, res) => {
  const page = Math.max(1, Number.parseInt(req.query.page, 10) || 1);
  const limit = Math.min(100, Math.max(1, Number.parseInt(req.query.limit, 10) || 10));
  const filter = { userId: req.user.id };
  if (req.query.search) filter.campaignName = { $regex: String(req.query.search).slice(0, 200).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), $options: 'i' };
  const [total, campaigns, hold] = await Promise.all([
    Campaign.countDocuments(filter),
    Campaign.find(filter).select('-recipients -emailTemplateBody -emailTemplateClosing').sort({ createdAt: -1 }).skip((page - 1) * limit).limit(limit).lean(),
    JobLock.findOne({ _id: mailboxHoldId(), expiresAt: { $gt: new Date() } }).lean(),
  ]);
  const terminalIds = campaigns.filter(campaign => retryStatuses.includes(campaign.status)).map(campaign => campaign._id);
  const eligible = terminalIds.length
    ? await Campaign.find({ _id: { $in: terminalIds }, recipients: { $elemMatch: rejectedRecipients } }).select('_id').lean()
    : [];
  const retryIds = new Set(eligible.map(campaign => String(campaign._id)));
  for (const campaign of campaigns) {
    campaign.canRetryRejected = retryIds.has(String(campaign._id));
    if (campaign.smtpHold?.until <= new Date()) campaign.smtpHold = null;
    if (hold && (!campaign.smtpHold || hold.expiresAt > campaign.smtpHold.until) &&
      (campaign.canRetryRejected || ['queued', 'scheduled', 'sending'].includes(campaign.status))) {
      campaign.smtpHold = { until: hold.expiresAt, reason: hold.reason };
    }
  }
  res.json({ campaigns, total });
});
exports.getCampaignById = asyncRoute(async (req, res) => {
  const campaign = await Campaign.findOne({ _id: objectId(req.params.id), userId: req.user.id });
  if (!campaign) fail(404, 'Campaign not found'); res.json(campaign);
});
exports.getTotalCampaigns = asyncRoute(async (req, res) => {
  const stats = await Campaign.aggregate([
    { $match: { userId: new (require('mongoose').Types.ObjectId)(req.user.id) } },
    { $group: { _id: null, totalCampaigns: { $sum: 1 }, totalEmailsSent: { $sum: '$totalEmailSent' }, totalOpened: { $sum: '$totalEmailOpened' } } },
  ]);
  res.json(stats[0] || { totalCampaigns: 0, totalEmailsSent: 0, totalOpened: 0 });
});
