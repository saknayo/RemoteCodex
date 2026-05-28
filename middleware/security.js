import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const BANS_FILE = path.join(__dirname, '..', 'storage', 'bans.json');

const CONFIG = {
  MAX_ATTEMPTS: 3,
  BLOCK_DURATION: 30 * 60,
  ATTEMPT_WINDOW: 15 * 60,
  LOGIN_INTERVAL: 30,
  RATE_LIMIT_MAX: 10,
  RATE_LIMIT_WINDOW: 60
};

function loadBans() {
  try {
    if (fs.existsSync(BANS_FILE)) {
      return JSON.parse(fs.readFileSync(BANS_FILE, 'utf8'));
    }
  } catch (error) {
    console.error('Error loading bans:', error);
  }
  return {};
}

function saveBans(bans) {
  try {
    fs.writeFileSync(BANS_FILE, JSON.stringify(bans, null, 2));
  } catch (error) {
    console.error('Error saving bans:', error);
  }
}

function getClientIP(req) {
  return req.headers['x-forwarded-for']?.split(',')[0].trim() || req.socket.remoteAddress;
}

function isBlocked(ip) {
  const bans = loadBans();
  const record = bans[ip];

  if (!record) return false;

  if (record.blockedAt && record.expiryAt) {
    const now = Date.now();
    const expiry = new Date(record.expiryAt).getTime();

    if (now < expiry) {
      return true;
    }

    delete bans[ip];
    saveBans(bans);
  }

  return false;
}

function getBlockExpiry(ip) {
  const bans = loadBans();
  return bans[ip]?.expiryAt || null;
}

function canAttemptLogin(ip) {
  const bans = loadBans();
  const record = bans[ip];
  const now = Date.now();

  if (!record) {
    return { allowed: true, waitSeconds: 0 };
  }

  if (record.blockedAt && record.expiryAt) {
    const expiry = new Date(record.expiryAt).getTime();
    if (now < expiry) {
      return { allowed: false, waitSeconds: Math.ceil((expiry - now) / 1000) };
    }
  }

  if (record.lastLogin) {
    const lastLoginTime = new Date(record.lastLogin).getTime();
    const elapsed = (now - lastLoginTime) / 1000;

    if (elapsed < CONFIG.LOGIN_INTERVAL) {
      return { allowed: false, waitSeconds: Math.ceil(CONFIG.LOGIN_INTERVAL - elapsed) };
    }
  }

  return { allowed: true, waitSeconds: 0 };
}

function recordFailedAttempt(ip) {
  const bans = loadBans();
  const now = new Date().toISOString();

  if (!bans[ip]) {
    bans[ip] = { attempts: 0 };
  }

  bans[ip].attempts++;
  bans[ip].lastAttempt = now;

  if (bans[ip].attempts >= CONFIG.MAX_ATTEMPTS) {
    const expiryTime = new Date(Date.now() + CONFIG.BLOCK_DURATION * 1000);
    bans[ip].blockedAt = now;
    bans[ip].expiryAt = expiryTime.toISOString();
    bans[ip].reason = 'login_failed';
    saveBans(bans);
    return { blocked: true, expiryAt: bans[ip].expiryAt };
  }

  saveBans(bans);
  return { blocked: false, attempts: bans[ip].attempts };
}

function clearFailedAttempts(ip) {
  const bans = loadBans();
  if (bans[ip]) {
    delete bans[ip];
    saveBans(bans);
  }
}

function recordLoginTime(ip) {
  const bans = loadBans();
  bans[ip] = {
    lastLogin: new Date().toISOString(),
    attempts: 0
  };
  saveBans(bans);
}

const rateLimitMap = new Map();

function checkRateLimit(ip) {
  const now = Date.now();
  const windowStart = now - CONFIG.RATE_LIMIT_WINDOW * 1000;

  let record = rateLimitMap.get(ip);

  if (!record) {
    record = { requests: [], blockedUntil: null };
    rateLimitMap.set(ip, record);
  }

  if (record.blockedUntil && now < record.blockedUntil) {
    return { allowed: false, retryAfter: Math.ceil((record.blockedUntil - now) / 1000) };
  }

  record.requests = record.requests.filter(time => time > windowStart);

  if (record.requests.length >= CONFIG.RATE_LIMIT_MAX) {
    record.blockedUntil = now + CONFIG.RATE_LIMIT_WINDOW * 1000;
    return { allowed: false, retryAfter: CONFIG.RATE_LIMIT_WINDOW };
  }

  record.requests.push(now);
  return { allowed: true };
}

function getSecurityStatus(ip) {
  const bans = loadBans();
  const record = bans[ip];
  const now = Date.now();

  const status = {
    isBlocked: false,
    remainingAttempts: CONFIG.MAX_ATTEMPTS,
    blockExpiry: null,
    canLogin: true,
    waitSeconds: 0
  };

  if (record) {
    if (record.blockedAt && record.expiryAt) {
      const expiry = new Date(record.expiryAt).getTime();
      if (now < expiry) {
        status.isBlocked = true;
        status.blockExpiry = record.expiryAt;
        status.canLogin = false;
        status.waitSeconds = Math.ceil((expiry - now) / 1000);
      }
    } else if (record.lastLogin) {
      const lastLoginTime = new Date(record.lastLogin).getTime();
      const elapsed = (now - lastLoginTime) / 1000;
      if (elapsed < CONFIG.LOGIN_INTERVAL) {
        status.canLogin = false;
        status.waitSeconds = Math.ceil(CONFIG.LOGIN_INTERVAL - elapsed);
      }
    }

    status.remainingAttempts = CONFIG.MAX_ATTEMPTS - (record.attempts || 0);
  }

  return status;
}

export {
  getClientIP,
  isBlocked,
  getBlockExpiry,
  canAttemptLogin,
  recordFailedAttempt,
  clearFailedAttempts,
  recordLoginTime,
  checkRateLimit,
  getSecurityStatus,
  CONFIG
};
