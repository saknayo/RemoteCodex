import bcrypt from 'bcryptjs';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const USERS_FILE = path.join(__dirname, '..', 'storage', 'users.json');

const SALT_ROUNDS = 10;

function loadUsers() {
  try {
    if (fs.existsSync(USERS_FILE)) {
      return JSON.parse(fs.readFileSync(USERS_FILE, 'utf8'));
    }
  } catch (error) {
    console.error('Error loading users:', error);
  }
  return {};
}

function saveUsers(users) {
  try {
    fs.writeFileSync(USERS_FILE, JSON.stringify(users, null, 2));
  } catch (error) {
    console.error('Error saving users:', error);
  }
}

export async function hashPassword(password) {
  return await bcrypt.hash(password, SALT_ROUNDS);
}

export async function verifyPassword(password, hash) {
  return await bcrypt.compare(password, hash);
}

export function findUser(username) {
  const users = loadUsers();
  const user = users[username];

  if (user) {
    return { username, ...user };
  }

  return null;
}

export async function createUser(username, password) {
  const users = loadUsers();

  if (users[username]) {
    throw new Error('User already exists');
  }

  const passwordHash = await hashPassword(password);

  users[username] = {
    passwordHash,
    createdAt: new Date().toISOString()
  };

  saveUsers(users);

  return { username, createdAt: users[username].createdAt };
}

export function initializeDefaultUser() {
  const username = process.env.ADMIN_USERNAME || 'admin';
  const password = process.env.ADMIN_PASSWORD;

  if (!password) {
    throw new Error('ADMIN_PASSWORD environment variable required for first-time setup');
  }

  const users = loadUsers();

  if (!users[username]) {
    createUser(username, password);
    console.log(`Default user '${username}' created from environment variables`);
  }
}

export default { hashPassword, verifyPassword, findUser, createUser, initializeDefaultUser };
