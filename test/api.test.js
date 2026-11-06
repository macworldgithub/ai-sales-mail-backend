const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const mongoose = require('mongoose');
const { MongoMemoryServer } = require('mongodb-memory-server-core');
let mongo, server, base, tokenA, tokenB, campaignId, templateId;
process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'isolated-test-jwt-secret';
process.env.CRON_SECRET = 'isolated-test-cron-secret';
process.env.TRACKING_SECRET = 'isolated-test-tracking-secret';
process.env.EMAIL_USER = 'sender@example.com';
process.env.EMAIL_PASS = 'test-only';
process.env.SERVER_URL = 'https://api.example.com';
process.env.FRONTEND_URL = 'http://localhost:5173';
// An empty value prevents dotenv from loading a real local provider key.
process.env.AI_API_KEY = '';
const Campaign = require('../models/compaign');
const Template = require('../models/Template');
const Reply = require('../models/automatedReplyEmail');
const FollowUp = require('../models/FollowUpEmail');
const { trackingToken, normalizeRecipients, mailContent, personalize } = require('../utils/email');
const { extractJson } = require('../controllers/emailGeneration');
const { deliver, runJobs } = require('../services/jobs');
const fields = { emailTemplateSubject: 'Hello {{First Name}}', emailTemplateBody: 'Meet {{First Name}}', emailTemplateClosing: 'Thank you' };
const campaignData = { campaignName: 'Launch', description: 'Product announcement', ...fields, recipients: [{ Email: 'CLIENT@example.com', 'First Name': '<Alice>' }] };
async function request(path, method = 'GET', data, token, headers = {}) {
  const response = await fetch(base + path, { method, headers: { ...(data ? { 'Content-Type': 'application/json' } : {}), ...(token ? { Authorization: `Bearer ${token}` } : {}), ...headers }, ...(data ? { body: JSON.stringify(data) } : {}) });
  const content = response.headers.get('content-type')?.includes('application/json') ? await response.json() : await response.arrayBuffer();
  return { status: response.status, data: content, headers: response.headers };
}
before(async () => {
  const path = require('node:path');
  const fs = require('node:fs');
  const cache = path.resolve(__dirname, '../.cache');
  fs.mkdirSync(cache, { recursive: true });
  const dbPath = fs.mkdtempSync(path.join(cache, 'test-db-'));
  mongo = await MongoMemoryServer.create({ instance: { dbPath }, binary: { version: '7.0.14', downloadDir: path.join(cache, 'mongodb') } });
  process.env.MONGO_URI = mongo.getUri('sales-mail-test');
  await require('../config/db')();
  await Promise.all([Campaign.init(), Template.init(), Reply.init(), FollowUp.init()]);
  server = require('../index').listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(async () => { if (server) await new Promise(resolve => server.close(resolve)); await mongoose.disconnect(); if (mongo) await mongo.stop(); });
test('health, allowed preflight and disallowed origins', async () => {
  assert.equal((await request('/health')).status, 200);
  assert.equal((await request('/ready')).status, 200);
  const preflight = await request('/campaigns/create', 'OPTIONS', undefined, undefined, { Origin: 'http://localhost:5173', 'Access-Control-Request-Method': 'POST', 'Access-Control-Request-Headers': 'authorization,idempotency-key' });
  assert.equal(preflight.status, 204);
  assert.equal(preflight.headers.get('access-control-allow-origin'), 'http://localhost:5173');
  assert.equal((await request('/health', 'GET', undefined, undefined, { Origin: 'https://untrusted.example' })).status, 403);
  assert.equal((await request('/api/cron/process')).status, 401);
  assert.equal((await request('/api/cron/status')).status, 401);
  const schedulerStatus = await request('/api/cron/status', 'GET', undefined, process.env.CRON_SECRET);
  assert.equal(schedulerStatus.status, 200);
  assert.equal((await request('/api/cron/process', 'GET', undefined, process.env.CRON_SECRET)).status, 409);
});
test('validates auth, normalizes email and expires tokens', async () => {
  assert.equal((await request('/api/auth/signup', 'POST', { email: {}, password: 'short' })).status, 400);
  const a = await request('/api/auth/signup', 'POST', { firstname: 'Alice', email: 'ALICE@example.com', password: 'correct-password' });
  assert.equal(a.status, 201); tokenA = a.data.token;
  const payload = require('jsonwebtoken').decode(tokenA);
  assert.ok(payload.exp > payload.iat);
  const b = await request('/api/auth/signup', 'POST', { firstname: 'Bob', email: 'bob@example.com', password: 'correct-password' });
  tokenB = b.data.token;
  assert.equal((await request('/api/auth/login', 'POST', { email: 'Alice@example.com', password: 'correct-password' })).status, 200);
  assert.equal((await request('/api/auth/login', 'POST', { email: 'alice@example.com', password: 'wrong-password' })).status, 401);
  assert.equal((await request('/campaigns/getAll')).status, 401);
});
test('validates recipient imports and safe placeholder substitution', () => {
  assert.throws(() => normalizeRecipients([]), /between 1 and 10000/);
  assert.throws(() => normalizeRecipients([{ email: 'bad' }]), /Invalid email/);
  assert.equal(normalizeRecipients([{ email: 'a@b.com' }, { Email: 'A@B.com' }]).length, 1);
  const [recipient] = normalizeRecipients([{ Email: 'A@b.com', 'First Name': '$& <script>', opened: 1, deliveryStatus: 'sent' }]);
  assert.equal(recipient.opened, 0); assert.equal(recipient.deliveryStatus, 'pending');
  assert.equal(personalize('Hello {{First Name}}', recipient), 'Hello $& <script>');
  assert.ok(mailContent(fields, recipient, '123').html.includes('&lt;script&gt;'));
  assert.equal(personalize('{{missing}}', recipient), '');
});

test('authenticated previews use the delivery renderer and never send mail', async () => {
  const data = { subject: 'An offer for {{First Name}}', body: 'Dear {{First Name}},\n\nWe can help your team. Your designation is {{Designation}}.', closing: 'Best regards,\n{{First Name}}', recipient: { Email: 'client@example.com', 'First Name': '' } };
  assert.equal((await request('/email/preview', 'POST', data)).status, 401);
  assert.equal((await request('/email/preview', 'POST', { ...data, recipient: { Email: 'bad' } }, tokenA)).status, 400);
  const response = await request('/email/preview', 'POST', data, tokenA);
  assert.equal(response.status, 200);
  assert.equal(response.data.emailContent.subject, 'An offer');
  assert.equal(response.data.emailContent.body, 'Hello,\n\nWe can help your team.');
  assert.equal(response.data.emailContent.closing, 'Best regards,\nsender@example.com');
  const [recipient] = normalizeRecipients([data.recipient]);
  const content = mailContent({ emailTemplateSubject: data.subject, emailTemplateBody: data.body, emailTemplateClosing: data.closing }, recipient, 'preview');
  assert.equal(content.text, response.data.emailContent.body + '\n\n' + response.data.emailContent.closing);
  assert.deepEqual(response.data.missingFields, ['First Name', 'Designation']);
});
test('campaign creation is idempotent and scoped to its owner', async () => {
  assert.equal((await request('/campaigns/create', 'POST', { ...campaignData, recipients: [] }, tokenA)).status, 400);
  const headers = { 'Idempotency-Key': 'test-request-key-123456789' };
  const first = await request('/campaigns/create', 'POST', campaignData, tokenA, headers);
  assert.equal(first.status, 201); campaignId = first.data.campaign._id;
  const retry = await request('/campaigns/create', 'POST', campaignData, tokenA, headers);
  assert.equal(retry.data.campaign._id, campaignId);
  assert.equal(await Campaign.countDocuments(), 1);
  assert.equal((await request('/campaigns/getAll', 'GET', undefined, tokenA)).data.total, 1);
  assert.equal((await request('/campaigns/getAll', 'GET', undefined, tokenB)).data.total, 0);
  assert.equal((await request('/campaigns/getById/' + campaignId, 'GET', undefined, tokenB)).status, 404);
  assert.equal((await request('/campaigns/getById/invalid', 'GET', undefined, tokenA)).status, 400);
  assert.equal((await request('/campaigns/getAll?search=%5B', 'GET', undefined, tokenA)).status, 200);
  assert.equal((await request('/campaigns/total', 'GET', undefined, tokenB)).data.totalCampaigns, 0);
});
test('template ownership cannot be changed by an update', async () => {
  const created = await request('/templates/create', 'POST', { templateName: 'Welcome', templatePurpose: 'Welcome people', emailSubject: 'Hi', emailBody: 'Welcome', emailClosing: 'Regards' }, tokenA);
  assert.equal(created.status, 201); templateId = created.data.template._id;
  assert.equal((await request('/templates/getById/' + templateId, 'GET', undefined, tokenB)).status, 404);
  assert.equal((await request('/templates/update/' + templateId, 'PUT', { emailSubject: 'Hacked' }, tokenB)).status, 404);
  const owner = require('jsonwebtoken').decode(tokenA).id;
  await request('/templates/update/' + templateId, 'PUT', { emailSubject: 'New', userId: require('jsonwebtoken').decode(tokenB).id }, tokenA);
  assert.equal(String((await Template.findById(templateId)).userId), owner);
  assert.equal((await request('/templates/total', 'GET', undefined, tokenB)).data.total, 0);
});
test('automation ownership, upsert and follow-up duration', async () => {
  assert.equal((await request('/automated-reply/enableAutomation', 'POST', { campaignId, ...fields }, tokenB)).status, 404);
  const enabled = await Promise.all([request('/automated-reply/enableAutomation', 'POST', { campaignId, ...fields }, tokenA), request('/automated-reply/enableAutomation', 'POST', { campaignId, ...fields }, tokenA)]);
  for (const response of enabled) assert.equal(response.status, 201);
  assert.equal(await Reply.countDocuments({ campaignId }), 1);
  assert.equal((await request('/follow-up/enableFollowUp', 'POST', { campaignId, ...fields, followUpDuration: 0 }, tokenA)).status, 400);
  assert.equal((await request('/follow-up/enableFollowUp', 'POST', { campaignId, ...fields, followUpDuration: 3 }, tokenA)).status, 201);
  assert.equal((await request('/follow-up/updateFollowUp/' + campaignId, 'PUT', { ...fields, followUpDuration: 7 }, tokenA)).status, 200);
  assert.equal((await Campaign.findById(campaignId)).followUpDuration, 7);
  assert.equal((await request('/follow-up/removeFollowUp/' + campaignId, 'DELETE', undefined, tokenB)).status, 404);
  assert.equal((await request('/follow-up/removeFollowUp/' + campaignId, 'DELETE', undefined, tokenA)).status, 200);
  assert.equal((await Campaign.findById(campaignId)).hasFollowUp, false);
});
test('AI parses plain and fenced JSON and reports unconfigured service', async () => {
  const expected = { subject: 'Hi', body: 'Body', closing: 'Bye' };
  assert.deepEqual(extractJson(JSON.stringify(expected)), expected);
  assert.deepEqual(extractJson('```json\n' + JSON.stringify(expected) + '\n```'), expected);
  assert.throws(() => extractJson('invalid'), /invalid JSON/);
  assert.throws(() => extractJson('{"subject":"Only subject"}'), /incomplete/);
  assert.equal((await request('/email/generate', 'POST', { emailPurpose: 'Welcome', templatePlaceholders: ['email'] }, tokenA)).status, 503);
  assert.equal((await request('/email/generateAutomatedEmail', 'POST', { campaignId }, tokenB)).status, 404);
});
test('delivery records success once and tracking counts first open exactly once', async () => {
  let calls = 0;
  let campaign = await Campaign.findById(campaignId);
  const transporter = { sendMail: async options => { calls++; assert.ok(options.html.includes('&lt;Alice&gt;')); return { accepted: [options.to], rejected: [] }; } };
  await deliver(transporter, campaign, campaign.recipients[0], campaign, 'initial');
  campaign = await Campaign.findById(campaignId);
  await deliver(transporter, campaign, campaign.recipients[0], campaign, 'initial');
  assert.equal(calls, 1);
  assert.equal(campaign.totalEmailSent, 1);
  const email = 'client@example.com';
  const url = '/email/emailTracker?' + new URLSearchParams({ campaignId, email, token: trackingToken(campaignId, email) });
  assert.equal((await request(url)).headers.get('content-type'), 'image/gif');
  assert.equal((await request(url)).status, 200);
  assert.equal((await Campaign.findById(campaignId)).totalEmailOpened, 1);
  assert.equal((await request(url.replace(/token=[^&]+/, 'token=bad'))).status, 400);
});
test('rejected SMTP delivery does not inflate sent counters', async () => {
  const owner = require('jsonwebtoken').decode(tokenA).id;
  const campaign = await Campaign.create({ userId: owner, campaignName: 'Failed send', description: 'Failure', ...fields, recipients: normalizeRecipients([{ email: 'other@example.com' }]) });
  await deliver({ sendMail: async () => { const error = new Error('SMTP unavailable'); error.code = 'ECONNECTION'; throw error; } }, campaign, campaign.recipients[0], campaign, 'initial');
  const fresh = await Campaign.findById(campaign._id);
  assert.equal(fresh.totalEmailSent, 0); assert.equal(fresh.recipients[0].deliveryStatus, 'failed'); assert.equal(fresh.recipients[0].initialAttempts, 1);
});
test('ambiguous SMTP outcomes are held for review instead of automatically resent', async () => {
  const owner = require('jsonwebtoken').decode(tokenA).id;
  const campaign = await Campaign.create({ userId: owner, campaignName: 'Uncertain send', description: 'Timeout', ...fields, recipients: normalizeRecipients([{ email: 'uncertain@example.com' }]) });
  let calls = 0;
  await deliver({ sendMail: async () => { calls++; throw new Error('Connection dropped after DATA'); } }, campaign, campaign.recipients[0], campaign, 'initial');
  const fresh = await Campaign.findById(campaign._id);
  await deliver({ sendMail: async () => { calls++; return { rejected: [] }; } }, fresh, fresh.recipients[0], fresh, 'initial');
  assert.equal(calls, 1); assert.equal(fresh.totalEmailSent, 0); assert.equal(fresh.recipients[0].deliveryStatus, 'sending');
});
test('scheduled worker sends due follow-ups and acknowledgements only once', async () => {
  const owner = require('jsonwebtoken').decode(tokenA).id;
  const old = new Date(Date.now() - 7 * 86400000);
  const recipients = normalizeRecipients([{ email: 'due@example.com' }, { email: 'replied@example.com' }, { email: 'future@example.com' }, { email: 'followed@example.com' }])
    .map((recipient, index) => ({ ...recipient, deliveryStatus: 'sent', sentAt: index === 2 ? new Date() : old, replied: index === 1 ? 1 : 0, ...(index === 1 ? { replyMessageId: '<reply@example.com>', messageId: '<original@example.com>' } : {}), ...(index === 3 ? { followUpStatus: 'sent' } : {}) }));
  const campaign = await Campaign.create({ userId: owner, campaignName: 'Scheduled', description: 'Worker test', ...fields, recipients, totalEmailSent: 4, status: 'sent', hasFollowUp: true, followUpDuration: 3, isAutomatedReply: true });
  await FollowUp.create({ campaignId: String(campaign._id), ...fields });
  await Reply.create({ campaignId: String(campaign._id), ...fields });
  const sent = [];
  const transporter = { sendMail: async options => { sent.push(options); return { rejected: [] }; } };
  await runJobs({ transporter, checkInbox: async () => {} });
  await runJobs({ transporter, checkInbox: async () => {} });
  assert.equal(sent.filter(mail => mail.to === 'due@example.com').length, 1);
  assert.equal(sent.filter(mail => mail.to === 'replied@example.com').length, 1);
  assert.equal(sent.filter(mail => ['future@example.com', 'followed@example.com'].includes(mail.to)).length, 0);
  const fresh = await Campaign.findById(campaign._id);
  assert.equal(fresh.totalEmailSent, 4);
  assert.equal(fresh.recipients[0].followUpStatus, 'sent');
  assert.equal(fresh.recipients[1].autoReplySent, true);
  assert.equal(sent.find(mail => mail.to === 'replied@example.com').inReplyTo, '<reply@example.com>');
});
test('future schedules use UTC and are not processed early', async () => {
  const { parseSchedule } = require('../utils/schedule');
  assert.equal(parseSchedule('2035-01-01T13:00:00+05:00').toISOString(), '2035-01-01T08:00:00.000Z');
  for (const value of ['invalid', '2000-01-01T00:00:00Z', '2035-01-01T13:00', 123]) assert.throws(() => parseSchedule(value));
  const created = await request('/campaigns/create', 'POST', { ...campaignData, scheduledAt: new Date(Date.now() + 3600000).toISOString() }, tokenA);
  assert.equal(created.status, 201); assert.equal(created.data.campaign.status, 'scheduled');
  const id = created.data.campaign._id;
  let sends = 0;
  const transporter = { sendMail: async () => { sends++; return { rejected: [] }; } };
  const result = await runJobs({ campaignId: id, userId: require('jsonwebtoken').decode(tokenA).id, includeAutomation: false, transporter });
  assert.equal(result.processed, 0); assert.equal(sends, 0);
  assert.equal((await request('/campaigns/' + id + '/process', 'POST', {}, tokenA)).status, 409);
  assert.equal((await request('/campaigns/' + id + '/process', 'POST', {}, tokenB)).status, 404);
  await Campaign.updateOne({ _id: id }, { $set: { scheduledAt: new Date(Date.now() - 60000) } });
  await runJobs({ campaignId: id, includeAutomation: false, transporter });
  assert.equal(sends, 1); assert.equal((await Campaign.findById(id)).status, 'sent');
});
test('only the owner can reschedule a campaign before delivery starts', async () => {
  const created = await request('/campaigns/create', 'POST', campaignData, tokenA);
  const id = created.data.campaign._id;
  const scheduledAt = new Date(Date.now() + 7200000).toISOString();
  assert.equal((await request('/campaigns/' + id + '/schedule', 'PATCH', { scheduledAt }, tokenB)).status, 404);
  assert.equal((await request('/campaigns/' + id + '/schedule', 'PATCH', { scheduledAt: 'bad' }, tokenA)).status, 400);
  const scheduled = await request('/campaigns/' + id + '/schedule', 'PATCH', { scheduledAt }, tokenA);
  assert.equal(scheduled.status, 200); assert.equal(scheduled.data.campaign.scheduledAt, scheduledAt);
  let sends = 0;
  const fresh = await Campaign.findById(id);
  await deliver({ sendMail: async () => { sends++; return { rejected: [] }; } }, fresh, fresh.recipients[0], fresh, 'initial');
  assert.equal(sends, 0);
  assert.equal((await request('/campaigns/' + id + '/schedule', 'PATCH', {}, tokenA)).status, 400);
  const immediate = await request('/campaigns/' + id + '/schedule', 'PATCH', { scheduledAt: null }, tokenA);
  assert.equal(immediate.status, 200); assert.equal(immediate.data.campaign.status, 'queued');
  await Campaign.updateOne({ _id: id }, { $set: { 'recipients.0.deliveryStatus': 'sending' } });
  assert.equal((await request('/campaigns/' + id + '/schedule', 'PATCH', { scheduledAt }, tokenA)).status, 409);
});
test('manual processing is scoped to the requested user and campaign', async () => {
  const a = await request('/campaigns/create', 'POST', campaignData, tokenA);
  const b = await request('/campaigns/create', 'POST', campaignData, tokenB);
  let sends = 0;
  await runJobs({ campaignId: a.data.campaign._id, userId: require('jsonwebtoken').decode(tokenA).id, includeAutomation: false, transporter: { sendMail: async () => { sends++; return { rejected: [] }; } } });
  assert.equal(sends, 1);
  assert.equal((await Campaign.findById(b.data.campaign._id)).totalEmailSent, 0);
});
test('lead imports skip missing emails and duplicates and personalize Client name', () => {
  const rows = normalizeRecipients([{ 'Client name': 'Ignored', 'Client email\t': '-' }, { 'Client name': 'Alice Jones', 'Client email\t': ' ALICE@example.com ' }, { 'Client name': 'Duplicate', 'Client email': 'alice@example.com' }, { 'Client name': 'Bob', 'Client email': '' }]);
  assert.equal(rows.length, 1); assert.equal(rows[0].email, 'alice@example.com');
  assert.equal(personalize('Hi {{Client Name}},', rows[0]), 'Hi Alice Jones,');
  assert.throws(() => normalizeRecipients([{ 'Client email': '-' }]), /No recipients/);
});

test('chunk settings are validated and timed gaps survive repeated processing and database reads', async () => {
  for (const config of [{ chunkSize: 0, chunkGapSeconds: 60 }, { chunkSize: 1001, chunkGapSeconds: 60 }, { chunkSize: 1.5, chunkGapSeconds: 60 }, { chunkSize: 50, chunkGapSeconds: 0 }]) {
    assert.equal((await request('/campaigns/create', 'POST', { ...campaignData, ...config }, tokenA)).status, 400);
  }
  const recipients = Array.from({ length: 5 }, (_, i) => ({ Email: `chunk${i}@example.com` }));
  const created = await request('/campaigns/create', 'POST', { ...campaignData, recipients, chunkSize: 2, chunkGapSeconds: 600 }, tokenA);
  assert.equal(created.status, 201);
  const id = created.data.campaign._id, sent = [];
  const transporter = { sendMail: async mail => { sent.push(mail.to); return { rejected: [] }; } };
  const run = () => runJobs({ campaignId: id, includeAutomation: false, transporter });
  await run();
  assert.deepEqual(sent, ['chunk0@example.com', 'chunk1@example.com']);
  let fresh = await Campaign.findById(id);
  assert.equal(fresh.currentChunk, 1); assert.ok(fresh.nextChunkAt > new Date(Date.now() + 590000));
  await run(); assert.equal(sent.length, 2);
  assert.equal((await request(`/campaigns/${id}/process`, 'POST', {}, tokenA)).status, 202);
  await deliver(transporter, fresh, fresh.recipients[2], fresh, 'initial'); assert.equal(sent.length, 2);
  await Campaign.updateOne({ _id: id }, { $set: { nextChunkAt: new Date(Date.now() - 1000) } });
  await run(); assert.equal(sent.length, 4);
  fresh = await Campaign.findById(id); assert.equal(fresh.currentChunk, 2); assert.ok(fresh.nextChunkAt > new Date());
  await run(); assert.equal(sent.length, 4);
  await Campaign.updateOne({ _id: id }, { $set: { nextChunkAt: new Date(Date.now() - 1000) } });
  await run(); assert.equal(new Set(sent).size, 5); assert.equal((await Campaign.findById(id)).status, 'sent');
});

test('a partial chunk retries only failed recipients before advancing and waits for its gap', async () => {
  const created = await request('/campaigns/create', 'POST', { ...campaignData, recipients: [{ Email: 'good@example.com' }, { Email: 'reject@example.com' }, { Email: 'next@example.com' }], chunkSize: 2, chunkGapSeconds: 300 }, tokenA);
  const id = created.data.campaign._id, sent = [];
  const transporter = { sendMail: async mail => { sent.push(mail.to); if (mail.to === 'reject@example.com') { const error = new Error('Rejected'); error.responseCode = 550; throw error; } return { rejected: [] }; } };
  const run = () => runJobs({ campaignId: id, includeAutomation: false, transporter });
  await run(); let fresh = await Campaign.findById(id); assert.equal(fresh.currentChunk, 0); assert.equal(fresh.nextChunkAt, null);
  await run(); fresh = await Campaign.findById(id); assert.equal(fresh.currentChunk, 0);
  await run(); fresh = await Campaign.findById(id); assert.equal(fresh.currentChunk, 1); assert.ok(fresh.nextChunkAt > new Date());
  await run(); assert.deepEqual(sent, ['good@example.com', 'reject@example.com', 'reject@example.com', 'reject@example.com']);
});

test('a 50-message chunk is not truncated to the old 25-message worker limit', async () => {
  const created = await request('/campaigns/create', 'POST', { ...campaignData, recipients: Array.from({ length: 51 }, (_, i) => ({ Email: `large${i}@example.com` })), chunkSize: 50, chunkGapSeconds: 60 }, tokenA);
  let sent = 0;
  const result = await runJobs({ campaignId: created.data.campaign._id, includeAutomation: false, transporter: { sendMail: async () => { sent++; return { rejected: [] }; } } });
  assert.equal(result.processed, 50); assert.equal(sent, 50);
  const fresh = await Campaign.findById(created.data.campaign._id); assert.equal(fresh.currentChunk, 1); assert.equal(fresh.totalEmailSent, 50);
});

test('branded templates retain the signature and emit an inline MIME image with safe public previews', async () => {
  const template = require('../data/templates/introducing-event-transportation.json');
  const saved = await request('/templates/create', 'POST', template, tokenA); assert.equal(saved.status, 201);
  assert.equal((await request('/templates/getById/' + saved.data.template._id, 'GET', undefined, tokenA)).data.emailSignatureId, 'event-transportation');
  assert.equal((await request('/templates/getById/' + saved.data.template._id, 'GET', undefined, tokenB)).status, 404);
  const [recipient] = normalizeRecipients([{ 'Client name': 'Morgan Example', 'Client email': 'morgan@example.com' }]);
  const fields = { emailTemplateSubject: template.emailSubject, emailTemplateBody: template.emailBody, emailTemplateClosing: template.emailClosing, emailSignatureId: template.emailSignatureId };
  const content = mailContent(fields, recipient, 'logo-test');
  assert.ok(content.text.includes('Hi Morgan Example,')); assert.ok(content.text.includes('James Cooper (Team Lead)'));
  assert.ok(content.html.includes('cid:event-transportation-signature@ai-sales-mail'));
  assert.equal(content.attachments[0].contentDisposition, 'inline'); assert.ok(require('fs').existsSync(content.attachments[0].path));
  const mime = await require('nodemailer').createTransport({ streamTransport: true, buffer: true }).sendMail({ from: 'sender@example.com', to: recipient.email, ...content });
  assert.ok(mime.message.toString().includes('Content-ID: <event-transportation-signature@ai-sales-mail>'));
  const preview = await request('/email/preview', 'POST', { subject: template.emailSubject, body: template.emailBody, closing: template.emailClosing, signatureId: template.emailSignatureId, recipient: recipient.data }, tokenA);
  assert.equal(preview.status, 200); assert.ok(preview.data.signature.url.endsWith('/email/assets/event-transportation-signature.png'));
  const image = await request('/email/assets/event-transportation-signature.png'); assert.equal(image.status, 200); assert.equal(image.headers.get('cross-origin-resource-policy'), 'cross-origin');
  assert.equal((await request('/email/preview', 'POST', { subject: 'A', body: 'B', closing: 'C', signatureId: '../../.env', recipient: recipient.data }, tokenA)).status, 400);
});

test('scheduled worker respects another invocation’s lease', async () => {
  const JobLock = require('../models/JobLock');
  await JobLock.updateOne({ _id: 'mail-jobs' }, { $set: { owner: 'another-worker', expiresAt: new Date(Date.now() + 60000) } }, { upsert: true });
  let calls = 0;
  const result = await runJobs({ transporter: { sendMail: async () => { calls++; } }, checkInbox: async () => {} });
  assert.equal(result.skipped, true); assert.equal(calls, 0);
});
test('auth requests are throttled with persistent counters', async () => {
  let limited = false;
  for (let index = 0; index < 31; index++) {
    const response = await request('/api/auth/login', 'POST', { email: 'invalid', password: 'short' });
    if (response.status === 429) { limited = true; assert.ok(Number(response.headers.get('retry-after')) > 0); break; }
  }
  assert.equal(limited, true);
});
test('database reconnects after a closed cached connection', async () => {
  await mongoose.disconnect();
  await require('../config/db')();
  assert.equal((await request('/templates/total', 'GET', undefined, tokenA)).status, 200);
});
