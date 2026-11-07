const { createHash } = require('node:crypto');

const LEGACY_REJECTION = 'The SMTP server rejected the message.';
const MINUTE = 60 * 1000;

function smtpFailure(error, now = Date.now()) {
  const code = String(error.code || '').match(/^[A-Z][A-Z0-9_]{0,31}$/)?.[0] || null;
  const command = String(error.command || '').match(/^(?:MAIL FROM|RCPT TO|[A-Z]+)(?=\s|$)/)?.[0] || null;
  const status = Number(error.responseCode) || null;
  let response = typeof error.response === 'string' ? error.response : '';
  if (command === 'AUTH') response = '';
  if (process.env.EMAIL_PASS) response = response.split(process.env.EMAIL_PASS).join('[redacted]');
  response = response.replace(/[^\s<>@]+@[^\s<>@]+/g, '[address]').replace(/\s+/g, ' ').trim().slice(0, 300);

  const rejected = status >= 400 && status < 600;
  const authentication = code === 'EAUTH';
  const confirmedRejected = rejected || authentication || code === 'EDNS' ||
    (code === 'ECONNECTION' && !command) || ['EHLO', 'HELO', 'STARTTLS', 'AUTH', 'MAIL FROM', 'RCPT TO'].includes(command);
  const quota = rejected && /\b(?:rate[ -]?limit|sending limit|send limit|daily limit|hourly limit|quota exceeded|too many (?:messages|emails)|limit (?:reached|exceeded))\b/i.test(response) &&
    !/\b[45]\.2\.2\b|mailbox (?:is )?full|storage quota|recipients? per message/i.test(response);
  const policy = rejected && command !== 'RCPT TO' && (
    /\b[45]\.7\.\d+\b/.test(response) || command === 'MAIL FROM' ||
    (command === 'DATA' && [450, 451, 452, 550, 554].includes(status) && !/\b[45]\.[123]\.\d+\b/.test(response))
  );
  let delay = 0;
  if (quota) delay = /daily|24[ -]?hour|per day/i.test(response) ? 1440 : 60;
  else if (authentication || policy) delay = 60;
  else if (status === 421 || status === 454) delay = 15;
  const retryAt = delay ? new Date(now + delay * MINUTE) : null;

  let message = 'Delivery outcome is uncertain. Check the sender mailbox or delivery logs before retrying.';
  if (authentication) message = 'SMTP authentication failed. Check the sender mailbox credentials.';
  else if (quota) message = 'SMTP sending limit reached. Delivery is paused until the retry time.';
  else if (retryAt) message = 'The SMTP provider restricted sending. Delivery is paused until the retry time.';
  else if (confirmedRejected) message = rejected ? LEGACY_REJECTION : 'SMTP failed before the message was accepted.';
  if (response) message += ` SMTP reply: ${response}`;
  else if (status || code) message += ` (${[status, code, command].filter(Boolean).join(' ')}).`;

  return { code, command, status, response, message, confirmedRejected, permanent: rejected && status >= 500 && !retryAt, retryAt };
}

function mailboxHoldId() {
  return 'smtp-hold:' + createHash('sha256').update((process.env.EMAIL_USER || '').trim().toLowerCase()).digest('hex');
}

function summarizeDeliveryErrors(recipients) {
  const uncertain = recipients.find(recipient => recipient.deliveryStatus === 'sending' && recipient.lastError);
  const messages = [uncertain?.lastError, ...recipients.map(recipient => recipient.lastError)].filter(Boolean);
  return [...new Set(messages)].slice(0, 3).join(' ') || null;
}

module.exports = { smtpFailure, mailboxHoldId, summarizeDeliveryErrors, LEGACY_REJECTION };
