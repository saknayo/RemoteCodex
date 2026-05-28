import jwt from '../utils/jwt.js';

export function verifyToken(req, res, next) {
  const authHeader = req.headers.authorization;

  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Missing token' });
  }

  const token = authHeader.substring(7);

  try {
    const decoded = jwt.verify(token);
    req.user = decoded;
    next();
  } catch (error) {
    return res.status(401).json({ error: 'Invalid token' });
  }
}

export function requireAuth(req, res, next) {
  if (!req.user) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  next();
}

export function requireSocketAuth(socket, next) {
  const token = socket.handshake.auth.token;

  if (!token) {
    return next(new Error('Missing token'));
  }

  try {
    const decoded = jwt.verify(token);
    socket.user = decoded;
    next();
  } catch (error) {
    next(new Error('Invalid token'));
  }
}
