const mongoose = require('mongoose');
const campaignSchema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'user', required: true, index: true },
  requestId: { type: String },
  campaignName: { type: String, required: true, trim: true },
  description: { type: String, required: true },
  status: { type: String, enum: ['draft', 'scheduled', 'queued', 'sending', 'sent', 'failed', 'attention'], default: 'queued' },
  scheduledAt: { type: Date, default: null, index: true },
  lastProcessedAt: { type: Date, default: null },
  lastDeliveryError: { type: String, default: null },
  hasFollowUp: { type: Boolean, default: false },
  followUpDuration: { type: Number, default: null },
  isAutomatedReply: { type: Boolean, default: false },
  emailTemplateBody: { type: String, required: true },
  emailTemplateSubject: { type: String, required: true },
  emailTemplateClosing: { type: String, required: true },
  totalEmailSent: { type: Number, default: 0 },
  totalEmailOpened: { type: Number, default: 0 },
  totalEmailReplied: { type: Number, default: 0 },
  recipients: [],
}, { timestamps: true });
campaignSchema.index({ userId: 1, createdAt: -1 });
campaignSchema.index({ userId: 1, requestId: 1 }, { unique: true, partialFilterExpression: { requestId: { $type: 'string' } } });
module.exports = mongoose.model('Campaign', campaignSchema);
