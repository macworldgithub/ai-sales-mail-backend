const { test } = require('node:test');
const assert = require('node:assert/strict');
const { renderEmail, personalize } = require('../utils/personalization');
const { mailContent } = require('../utils/email');
const sender = { email: 'sales@example.com' };
const template = {
  emailTemplateSubject: 'Test Email for {{First Name}} {{Last Name}}',
  emailTemplateBody: 'Dear {{First Name}} {{Last Name}},\n\nThis is a test email for the {{Job Title}} at {{Company}}.\n\nPlease reply using {{Email}} or {{email}}.',
  emailTemplateClosing: 'Best regards,\n{{First Name}} {{Last Name}}',
};
const emptyRecipient = { email: 'client@example.com', data: { 'First Name': '', 'Last Name': ' ', 'Job Title': '', Company: '' } };

test('the screenshot template renders professionally when every optional field is blank', () => {
  const result = renderEmail(template, emptyRecipient, sender);
  assert.equal(result.subject, 'Test Email');
  assert.equal(result.body, 'Hello,\n\nPlease reply using client@example.com.');
  assert.equal(result.closing, 'Best regards,\nsales@example.com');
  assert.deepEqual(result.missingFields, ['First Name', 'Last Name', 'Job Title', 'Company']);
});

test('missing keys, whitespace and common spreadsheet markers use the same fallback', () => {
  for (const value of [undefined, null, '', '  ', 'N/A', 'NA', 'unknown', 'null', 'Not Provided', '-']) {
    const data = Object.fromEntries(['First Name', 'Last Name', 'Job Title', 'Company'].map(key => [key, value]));
    assert.equal(renderEmail(template, { ...emptyRecipient, data }, sender).body, 'Hello,\n\nPlease reply using client@example.com.');
  }
});

test('known names, designation and company remain personalized; sender does not become the recipient', () => {
  const result = renderEmail(template, { email: 'alice@example.com', data: { first_name: 'Alice', lastName: 'Lee', Designation: 'Director', 'Company Name': 'Acme' } }, sender);
  assert.equal(result.subject, 'Test Email for Alice Lee');
  assert.ok(result.body.includes('Dear Alice Lee,'));
  assert.ok(result.body.includes('Director at Acme.'));
  assert.equal(result.closing, 'Best regards,\nsales@example.com');
  assert.deepEqual(result.missingFields, []);
});

test('partially known names still receive a complete greeting', () => {
  const result = renderEmail(template, { ...emptyRecipient, data: { 'First Name': 'Alice' } }, sender);
  assert.ok(result.body.startsWith('Hello Alice,'));
  assert.ok(!result.body.includes('Dear Alice ,'));
});

test('optional fallback phrases preserve complete sentences without invented facts', () => {
  const result = renderEmail({ ...template, emailTemplateSubject: 'An update for {{Company|your organization}}', emailTemplateBody: 'Hello {{First Name}},\n\nWe can help {{Company|your organization}}. Your role is {{Designation}}. Would you like to learn more?' }, emptyRecipient, sender);
  assert.equal(result.subject, 'An update for your organization');
  assert.equal(result.body, 'Hello,\n\nWe can help your organization. Would you like to learn more?');
});

test('unknown personal details remove only dependent sentences, preserving links and abbreviations', () => {
  const result = renderEmail({ ...template, emailTemplateBody: 'Dear {{First Name}},\n\nSee https://example.com/offer. Dr. {{Last Name}} works at {{Company}}. Please contact sales@example.com.' }, emptyRecipient, sender);
  assert.equal(result.body, 'Hello,\n\nSee https://example.com/offer. Please contact sales@example.com.');
});

test('an entirely unavailable message receives a neutral body and nonempty subject', () => {
  const result = renderEmail({ emailTemplateSubject: '{{missing}}', emailTemplateBody: '{{missing}}', emailTemplateClosing: '{{missing}}' }, emptyRecipient, sender);
  assert.equal(result.subject, 'A quick introduction');
  assert.match(result.body, /^Hello,\n\nI'm reaching out to connect\./);
  assert.equal(result.closing, 'Best regards,\nsales@example.com');
  assert.ok(!JSON.stringify(result).includes('{{'));
});

test('literal sender signatures remain intact and sender placeholders use configured identity', () => {
  const recipient = { ...emptyRecipient, data: { 'Sender Name': 'Wrong sender', 'Sender Email': 'wrong@example.com' } };
  const signature = { ...template, emailTemplateClosing: 'Best regards,\n{{Sender Name}}\n{{Sender Email}}' };
  assert.equal(renderEmail(signature, recipient, { name: 'Our Sales Team', ...sender }).closing, 'Best regards,\nOur Sales Team\nsales@example.com');
  assert.equal(renderEmail({ ...template, emailTemplateClosing: 'Regards,\nJane Smith\nSales Team' }, recipient, sender).closing, 'Regards,\nJane Smith\nSales Team');
});

test('recipient values are substituted literally once and mail HTML stays escaped', () => {
  process.env.TRACKING_SECRET = 'isolated-personalization-test';
  process.env.SERVER_URL = 'https://api.example.com';
  process.env.EMAIL_USER = sender.email;
  const recipient = { email: 'client@example.com', data: { 'First Name': '$& <script>{{other}}</script>' } };
  assert.equal(personalize('{{ first_name }}', recipient), '$& <script>{{other}}</script>');
  const content = mailContent({ ...template, emailTemplateSubject: 'Offer\nfor {{missing}}', emailTemplateBody: 'Hello {{First Name}},\n\nWelcome.' }, recipient, '123');
  assert.ok(!/[\r\n]/.test(content.subject));
  assert.ok(content.html.includes('&lt;script&gt;{{other}}&lt;/script&gt;'));
  assert.ok(!content.html.includes('<script>'));
  assert.ok(content.html.includes('/email/emailTracker?'));
  assert.ok(content.text.includes(sender.email));
  const injected = renderEmail({ ...template, emailTemplateSubject: 'Offer for {{First Name}} at {{Company}}' }, { email: recipient.email, data: { 'First Name': 'Alice\r\nBcc: injected@example.com' } }, sender);
  assert.ok(!/[\r\n]/.test(injected.subject));
});
