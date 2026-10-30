const express = require("express");
const {
  GenerateEmail,
  MakeChangesToEmail,
  TrackEmail,
  GenerateAutomatedEmail,
  GenerateAutomatedFollowUpEmail
} = require("../controllers/emailGeneration");

const authMiddleware = require("../middlewares/authMiddleware");
const router = express.Router();
router.use((req, res, next) => req.method === 'POST' ? authMiddleware(req, res, next) : next());
router.use((req, res, next) => req.method === 'POST' ? require('../middlewares/rateLimit')('ai', 60, 3600000)(req, res, next) : next());

router.post("/generate", authMiddleware, GenerateEmail);
router.post("/makeChanges", authMiddleware, MakeChangesToEmail);
router.post("/generateAutomatedEmail", authMiddleware, GenerateAutomatedEmail);
router.post("/generateAutomatedFollowUpEmail", authMiddleware, GenerateAutomatedFollowUpEmail);
router.get("/emailTracker", TrackEmail);

module.exports = router;
