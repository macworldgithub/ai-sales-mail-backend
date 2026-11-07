const express = require("express");
const {
  createCampaign,
  getAllCampaigns,
  getCampaignById,
  getTotalCampaigns,
  updateSchedule,
  processCampaign,
  retryRejected,
} = require("../controllers/CampaignController");
const authMiddleware = require("../middlewares/authMiddleware");

const router = express.Router();

router.post("/create",authMiddleware, createCampaign);
router.get("/total", authMiddleware,getTotalCampaigns);
router.get("/getAll",authMiddleware, getAllCampaigns);
router.get("/getById/:id", authMiddleware,getCampaignById);
router.patch('/:id/schedule', authMiddleware, updateSchedule);
router.post('/:id/process', authMiddleware, require('../middlewares/rateLimit')('delivery', 120, 3600000), processCampaign);
router.post('/:id/retry-rejected', authMiddleware, require('../middlewares/rateLimit')('delivery', 120, 3600000), retryRejected);

module.exports = router;
