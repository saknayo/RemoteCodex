import express from 'express';
import * as jwt from '../utils/jwt.js';
import * as password from '../utils/password.js';
import * as security from '../middleware/security.js';

const router = express.Router();

router.post('/login', async (req, res) => {
  const { username, password: pwd } = req.body;
  const ip = security.getClientIP(req);
  const now = Date.now();

  if (!username || !pwd) {
    return res.status(400).json({ error: 'Username and password required' });
  }

  const rateLimit = security.checkRateLimit(ip);
  if (!rateLimit.allowed) {
    return res.status(429).json({
      error: 'rate_limit',
      message: '请求过于频繁，请稍后再试',
      retryAfter: rateLimit.retryAfter
    });
  }

  const canLogin = security.canAttemptLogin(ip);
  if (!canLogin.allowed) {
    if (security.isBlocked(ip)) {
      return res.status(403).json({
        error: 'IP_blocked',
        message: 'IP已被封禁',
        expiryAt: security.getBlockExpiry(ip)
      });
    }

    return res.status(429).json({
      error: 'too_soon',
      message: `请等待 ${canLogin.waitSeconds} 秒后再次尝试`,
      waitSeconds: canLogin.waitSeconds
    });
  }

  const user = password.findUser(username);

  if (!user || !(await password.verifyPassword(pwd, user.passwordHash))) {
    const result = security.recordFailedAttempt(ip);

    if (result.blocked) {
      return res.status(403).json({
        error: 'IP_blocked',
        message: '登录失败次数过多，IP已被封禁30分钟',
        expiryAt: result.expiryAt
      });
    }

    const remaining = security.CONFIG.MAX_ATTEMPTS - result.attempts;

    return res.status(401).json({
      error: 'invalid_credentials',
      message: `用户名或密码错误，剩余尝试次数：${remaining} 次`,
      remainingAttempts: remaining
    });
  }

  security.clearFailedAttempts(ip);
  security.recordLoginTime(ip);

  const token = jwt.sign({ username: user.username });

  res.json({
    token,
    user: { username: user.username }
  });
});

router.post('/logout', (req, res) => {
  res.json({ success: true });
});

router.get('/verify', (req, res) => {
  const authHeader = req.headers.authorization;

  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ valid: false });
  }

  const token = authHeader.substring(7);

  try {
    const decoded = jwt.verify(token);
    res.json({ valid: true, user: { username: decoded.username } });
  } catch (error) {
    res.status(401).json({ valid: false });
  }
});

router.get('/status', (req, res) => {
  const ip = security.getClientIP(req);
  const status = security.getSecurityStatus(ip);
  res.json(status);
});

router.post('/change', async (req, res) => {
  const { username, oldPassword, newPassword } = req.body;

  if (!username || !oldPassword || !newPassword) {
    return res.status(400).json({ error: 'Missing required fields' });
  }

  const user = password.findUser(username);

  if (!user || !(await password.verifyPassword(oldPassword, user.passwordHash))) {
    return res.status(401).json({ error: 'Invalid current password' });
  }

  const passwordHash = await password.hashPassword(newPassword);

  const fs = await import('fs');
  const path = await import('path');
  const { fileURLToPath } = await import('url');

  const __filename = fileURLToPath(import.meta.url);
  const __dirname = path.dirname(__filename);
  const USERS_FILE = path.join(__dirname, '..', 'storage', 'users.json');

  const users = JSON.parse(fs.readFileSync(USERS_FILE, 'utf8'));
  users[username].passwordHash = passwordHash;
  fs.writeFileSync(USERS_FILE, JSON.stringify(users, null, 2));

  res.json({ success: true });
});

export default router;
