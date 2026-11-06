const mongoose = require("mongoose");

const emailTemplateSchema = new mongoose.Schema(
  {
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'user', required: true, index: true },
    templateName: {
      type: String,
      required: true,
    },
    emailSignatureId: { type: String, default: null },
    templatePurpose: {
      type: String,
      required: true,
    },
    emailSubject: {
      type: String,
      required: true,
    },
    emailBody: {
      type: String,
      required: true,
    },
    emailClosing: {
      type: String,
      required: true,
    },
  },
  { timestamps: true }
);

module.exports = mongoose.model("emailtemplate", emailTemplateSchema);
