const Template = require('../models/Template');
const { asyncRoute, fail, text, objectId } = require('../utils/http');
const fields = ['templateName', 'templatePurpose', 'emailSubject', 'emailBody', 'emailClosing'];
exports.CreateTemplate = asyncRoute(async (req, res) => {
  const data = Object.fromEntries(fields.map(key => [key, text(req.body[key], key)]));
  data.emailSignatureId = require('../utils/signatures').signatureId(req.body.emailSignatureId);
  const template = await Template.create({ ...data, userId: req.user.id });
  res.status(201).json({ message: 'Template saved', template });
});
exports.GetTemplateNames = asyncRoute(async (req, res) => res.json(await Template.find({ userId: req.user.id }).select('templateName templatePurpose').sort({ createdAt: -1 })));
exports.getTotalTemplates = asyncRoute(async (req, res) => res.json({ total: await Template.countDocuments({ userId: req.user.id }) }));
exports.GetTemplateById = asyncRoute(async (req, res) => {
  const template = await Template.findOne({ _id: objectId(req.params.id), userId: req.user.id });
  if (!template) fail(404, 'Template not found');
  res.json(template);
});
exports.UpdateTemplateById = asyncRoute(async (req, res) => {
  const data = Object.fromEntries(fields.filter(key => req.body[key] !== undefined).map(key => [key, text(req.body[key], key)]));
  if (Object.hasOwn(req.body, 'emailSignatureId')) data.emailSignatureId = require('../utils/signatures').signatureId(req.body.emailSignatureId);
  if (!Object.keys(data).length) fail(400, 'No template fields provided');
  const template = await Template.findOneAndUpdate({ _id: objectId(req.params.id), userId: req.user.id }, { $set: data }, { new: true, runValidators: true });
  if (!template) fail(404, 'Template not found');
  res.json({ message: 'Template updated', template });
});
