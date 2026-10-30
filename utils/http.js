const mongoose = require('mongoose');
const asyncRoute = fn => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
const fail = (status, message) => { const error = new Error(message); error.status = status; error.expose = true; throw error; };
function text(value, label, max = 20000) {
  if (typeof value !== 'string' || !value.trim() || value.length > max) fail(400, `${label} is required and must be at most ${max} characters`);
  return value.trim();
}
function objectId(value) {
  if (!mongoose.isObjectIdOrHexString(value)) fail(400, 'Invalid resource ID');
  return value;
}
function emailFields(body) {
  return Object.fromEntries(['emailTemplateSubject', 'emailTemplateBody', 'emailTemplateClosing'].map(key => [key, text(body[key], key)]));
}
module.exports = { asyncRoute, fail, text, objectId, emailFields };
