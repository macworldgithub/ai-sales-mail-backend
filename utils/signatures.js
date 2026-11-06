const path = require('node:path');
const { fail } = require('./http');
const signatures = {
  'event-transportation': {
    filename: 'event-transportation-signature.png',
    cid: 'event-transportation-signature@ai-sales-mail',
    alt: 'Event Transportation — James Cooper, Team Lead. (470) 206 2485. sales@eventtransportation.events. eventtransportation.events',
    href: 'https://eventtransportation.events/',
  },
};
function signatureId(value) {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value !== 'string' || !Object.hasOwn(signatures, value)) fail(400, 'Choose a supported email signature');
  return value;
}
function signatureFor(value) {
  const id = signatureId(value);
  if (!id) return null;
  const signature = signatures[id];
  return { ...signature, path: path.join(__dirname, '..', 'assets', 'email', signature.filename), url: `${process.env.SERVER_URL.replace(/\/$/, '')}/email/assets/${signature.filename}`, width: 600, height: 300 };
}
module.exports = { signatureId, signatureFor };
