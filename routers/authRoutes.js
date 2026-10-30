const router = require('express').Router();
const { body } = require('express-validator');
const { signup, login } = require('../controllers/authController');
const credentials = [
  body('email').isString().bail().trim().isEmail().withMessage('A valid email is required'),
  body('password').isString().bail().isLength({ min: 6 }).withMessage('Password must contain at least 6 characters').bail().custom(value => Buffer.byteLength(value, 'utf8') <= 72).withMessage('Password must be at most 72 UTF-8 bytes'),
];
router.post('/signup', [body('firstname').isString().bail().trim().isLength({ min: 1, max: 100 }).withMessage('Name is required'), ...credentials], signup);
router.post('/login', credentials, login);
module.exports = router;
