const controller = require('./automationController')(require('../models/FollowUpEmail'), true);

module.exports = { enableFollowUp: controller.enable, removeFollowUp: controller.remove, getFollowUpByCompaignId: controller.get, updateFollowUp: controller.update };
