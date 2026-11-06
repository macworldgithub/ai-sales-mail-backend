const crypto = require('node:crypto');
const { fail } = require('./http');
const { personalize, renderEmail } = require('./personalization');
function normalizeRecipients(rows) {
  if (!Array.isArray(rows) || !rows.length || rows.length > 10000) fail(400, 'Upload between 1 and 10000 source rows');
  const seen = new Set();
  const recipients = rows.map((row, index) => {
    if (!row || typeof row !== 'object' || Array.isArray(row)) fail(400, `Invalid recipient in row ${index + 1}`);
    const data = Object.fromEntries(Object.entries(row).filter(([key]) => !key.startsWith('$') && !['__proto__', 'constructor', 'prototype'].includes(key)).map(([key, value]) => [key.trim(), String(value ?? '').slice(0, 2000)]));
    const emailKey = Object.keys(data).find(key => ['email', 'emailaddress', 'clientemail', 'clientemailaddress', 'customeremail', 'contactemail'].includes(key.toLowerCase().replace(/[\s_-]+/g, '')));
    const email = (data[emailKey] || '').trim().toLowerCase();
    if (!email || /^(?:-|n\/?a|none|null|undefined|not available)$/i.test(email)) return null;
    if (!/^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(email)) fail(400, `Invalid email in row ${index + 1}`);
    if (seen.has(email)) return null;
    seen.add(email);
    return { data, email, opened: 0, replied: 0, sentAt: null, updatedAt: null, deliveryStatus: 'pending', attempts: 0, autoReplySent: false };
  }).filter(Boolean);
  if (!recipients.length) fail(400, 'No recipients have a valid email address');
  if (recipients.length > 5000) fail(400, 'Upload at most 5000 unique recipients');
  return recipients;
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
  const { subject, body, closing } = renderEmail(template, recipient, { name: process.env.EMAIL_FROM_NAME, email: process.env.EMAIL_USER });
  const query = new URLSearchParams({ campaignId: String(campaignId), email: recipient.email, token: trackingToken(campaignId, recipient.email) });
  const signature = require('./signatures').signatureFor(template.emailSignatureId);
  const signatureHtml = signature ? `<p><a href="${signature.href}"><img src="cid:${signature.cid}" alt="${escapeHtml(signature.alt)}" width="600" height="300" style="display:block;width:100%;max-width:600px;height:auto;border:0"></a></p>` : '';
  return { subject, text: `${body}\n\n${closing}`, html: `<div style="font-family:Arial,sans-serif;font-size:15px;line-height:1.6;color:#242424;max-width:680px"><p>${escapeHtml(body).replace(/\n/g, '<br>')}</p><p>${escapeHtml(closing).replace(/\n/g, '<br>')}</p>${signatureHtml}</div><img src="${process.env.SERVER_URL.replace(/\/$/, '')}/email/emailTracker?${query}" width="1" height="1" alt="">`, ...(signature ? { attachments: [{ filename: signature.filename, path: signature.path, cid: signature.cid, contentDisposition: 'inline', contentType: 'image/png' }] } : {}) };
}
module.exports = { normalizeRecipients, personalize, trackingToken, validTrackingToken, mailContent };
