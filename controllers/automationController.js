const Campaign = require('../models/compaign');
const { asyncRoute, fail, objectId, emailFields } = require('../utils/http');
module.exports = (Model, followUp = false) => {
  const flag = followUp ? 'hasFollowUp' : 'isAutomatedReply';
  async function owned(req) {
    const id = objectId(req.params.id || req.body.campaignId);
    const campaign = await Campaign.findOne({ _id: id, userId: req.user.id });
    if (!campaign) fail(404, 'Campaign not found');
    return campaign;
  }
  function duration(body) {
    const days = Number(body.followUpDuration);
    if (!Number.isInteger(days) || days < 1 || days > 365) fail(400, 'Follow-up frequency must be a whole number between 1 and 365 days');
    return days;
  }
  return {
    enable: asyncRoute(async (req, res) => {
      const campaign = await owned(req);
      const data = emailFields(req.body);
      const update = { [flag]: true };
      if (followUp) update.followUpDuration = duration(req.body);
      let automation;
      try {
        automation = await Model.findOneAndUpdate({ campaignId: String(campaign._id) }, { $set: data, $setOnInsert: { _id: campaign._id } }, { upsert: true, new: true, runValidators: true });
      } catch (error) {
        if (error.code !== 11000) throw error;
        automation = await Model.findOneAndUpdate({ campaignId: String(campaign._id) }, { $set: data }, { new: true, runValidators: true });
        if (!automation) throw error;
      }
      await Campaign.updateOne({ _id: campaign._id, userId: req.user.id }, { $set: update });
      res.status(201).json({ message: 'Automation enabled', automation });
    }),
    remove: asyncRoute(async (req, res) => {
      const campaign = await owned(req);
      await Campaign.updateOne({ _id: campaign._id, userId: req.user.id }, { $set: { [flag]: false, ...(followUp ? { followUpDuration: null } : {}) } });
      await Model.deleteMany({ campaignId: String(campaign._id) });
      res.json({ message: 'Automation removed' });
    }),
    get: asyncRoute(async (req, res) => {
      const campaign = await owned(req);
      res.json(await Model.find({ campaignId: String(campaign._id) }).sort({ updatedAt: -1 }).limit(1));
    }),
    update: asyncRoute(async (req, res) => {
      const campaign = await owned(req);
      const data = emailFields(req.body);
      const days = followUp ? duration(req.body) : null;
      const automation = await Model.findOneAndUpdate({ campaignId: String(campaign._id) }, { $set: data }, { new: true, runValidators: true });
      if (!automation) fail(404, 'Automation not found');
      if (followUp) await Campaign.updateOne({ _id: campaign._id, userId: req.user.id }, { $set: { followUpDuration: days } });
      res.json(automation);
    }),
  };
};
