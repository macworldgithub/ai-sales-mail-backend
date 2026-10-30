const crypto = require('node:crypto');
const { fail } = require('./http');
function normalizeRecipients(rows) {
  if (!Array.isArray(rows) || !rows.length || rows.length > 1000) fail(400, 'Upload between 1 and 1000 recipients');
  const seen = new Set();
  return rows.map((row, index) => {
    if (!row || typeof row !== 'object' || Array.isArray(row)) fail(400, `Invalid recipient in row ${index + 1}`);
    const data = Object.fromEntries(Object.entries(row).filter(([key]) => !key.startsWith('$') && !['__proto__', 'constructor', 'prototype'].includes(key)).map(([key, value]) => [key.trim(), String(value ?? '').slice(0, 2000)]));
    const emailKey = Object.keys(data).find(key => key.toLowerCase() === 'email');
    const email = (data[emailKey] || '').trim().toLowerCase();
    if (!/^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(email)) fail(400, `Invalid email in row ${index + 1}`);
    if (seen.has(email)) fail(400, `Duplicate recipient: ${email}`);
    seen.add(email);
    return { data, email, opened: 0, replied: 0, sentAt: null, updatedAt: null, deliveryStatus: 'pending', attempts: 0, autoReplySent: false };
  });
}
function personalize(template, recipient) {
  const values = { ...recipient.data, email: recipient.email };
  return template.replace(/{{\s*([^{}]+?)\s*}}/g, (match, key) => Object.hasOwn(values, key) ? String(values[key]) : match);
}
const escapeHtml = value => value.replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
function trackingToken(campaignId, email) {
  return crypto.createHmac('sha256', process.env.TRACKING_SECRET).update(`${campaignId}:${email.toLowerCase()}`).digest('hex');
}
function validTrackingToken(campaignId, email, token) {
  if (!process.env.TRACKING_SECRET || typeof token !== 'string' || !/^[a-f0-9]{64}$/.test(token)) return false;
  return crypto.timingSafeEqual(Buffer.from(token), Buffer.from(trackingToken(campaignId, email)));
}
function mailContent(template, recipient, campaignId) {
  const subject = personalize(template.emailTemplateSubject, recipient).replace(/[\r\n]/g, ' ');
  const body = personalize(template.emailTemplateBody, recipient);
  const closing = personalize(template.emailTemplateClosing, recipient);
  const query = new URLSearchParams({ campaignId: String(campaignId), email: recipient.email, token: trackingToken(campaignId, recipient.email) });
  return { subject, text: `${body}\n\n${closing}`, html: `<p>${escapeHtml(body).replace(/\n/g, '<br>')}</p><p>${escapeHtml(closing).replace(/\n/g, '<br>')}</p><img src="${process.env.SERVER_URL.replace(/\/$/, '')}/email/emailTracker?${query}" width="1" height="1" alt="">` };
}
module.exports = { normalizeRecipients, personalize, trackingToken, validTrackingToken, mailContent };
