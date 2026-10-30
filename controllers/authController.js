const User = require('../models/User');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { validationResult } = require('express-validator');
const { asyncRoute, fail } = require('../utils/http');
function validate(req) {
  const errors = validationResult(req);
  if (!errors.isEmpty()) fail(400, errors.array()[0].msg);
  if (!process.env.JWT_SECRET) fail(503, 'Authentication is not configured');
}
function session(user) {
  return { token: jwt.sign({ id: user._id }, process.env.JWT_SECRET, { expiresIn: '7d', algorithm: 'HS256' }), user: { firstname: user.firstname, email: user.email } };
}
exports.signup = asyncRoute(async (req, res) => {
  validate(req);
  const email = req.body.email.trim().toLowerCase();
  if (await User.exists({ email })) fail(409, 'An account with this email already exists');
  const password = await bcrypt.hash(req.body.password, 12);
  const user = await User.create({ firstname: req.body.firstname.trim(), email, password });
  res.status(201).json(session(user));
});
exports.login = asyncRoute(async (req, res) => {
  validate(req);
  const user = await User.findOne({ email: req.body.email.trim().toLowerCase() });
  if (!user || !await bcrypt.compare(req.body.password, user.password)) fail(401, 'Invalid email or password');
  res.json(session(user));
});
