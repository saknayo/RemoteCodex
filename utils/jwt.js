import jwt from 'jsonwebtoken';

const SECRET = process.env.JWT_SECRET || 'default_secret_key_change_in_production';
const EXPIRY = process.env.JWT_EXPIRY || '7d';

export function sign(payload) {
  return jwt.sign(payload, SECRET, { expiresIn: EXPIRY });
}

export function verify(token) {
  return jwt.verify(token, SECRET);
}

export default { sign, verify };
