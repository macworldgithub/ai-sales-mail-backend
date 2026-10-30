const controller = require('./automationController')(require('../models/automatedReplyEmail'));
module.exports = { enableAutomatedReply: controller.enable, removeAutomatedReply: controller.remove, getAutomationByCompaignId: controller.get, updateAutomatedReply: controller.update };
