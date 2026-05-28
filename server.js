import express from 'express';
import { createServer } from 'http';
import { Server } from 'socket.io';
import { spawn } from 'child_process';
import { v4 as uuidv4 } from 'uuid';
import fs from 'fs';
import path from 'path';
import 'dotenv/config';

import * as password from './utils/password.js';
import { verifyToken, requireAuth, requireSocketAuth } from './middleware/auth.js';
import authRoutes from './routes/auth.js';

const app = express();
const httpServer = createServer(app);
const io = new Server(httpServer, {
  cors: { origin: '*' }
});

const PORT = process.env.PORT || 3000;
const SESSIONS_DIR = path.join(process.cwd(), 'sessions');
const CLI_PATH = process.env.CLI_PATH || '/root/.nvm/versions/node/v24.14.0/bin/claude';

if (!fs.existsSync(SESSIONS_DIR)) {
  fs.mkdirSync(SESSIONS_DIR, { recursive: true });
}

password.initializeDefaultUser();

const activeProcesses = new Map();

app.use(express.static('public'));
app.use(express.json({ limit: '50mb' }));

app.use('/api/auth', authRoutes);

function getSessionFilePath(id) {
  return path.join(SESSIONS_DIR, `${id}.json`);
}

function loadSession(id) {
  const sessionPath = getSessionFilePath(id);
  if (fs.existsSync(sessionPath)) {
    return JSON.parse(fs.readFileSync(sessionPath, 'utf8'));
  }
  return null;
}

function saveSession(session) {
  const sessionPath = getSessionFilePath(session.id);
  fs.writeFileSync(sessionPath, JSON.stringify(session, null, 2));
}

app.get('/api/sessions', verifyToken, requireAuth, (req, res) => {
  const sessions = [];

  for (const file of fs.readdirSync(SESSIONS_DIR)) {
    if (file.endsWith('.json')) {
      const data = JSON.parse(fs.readFileSync(path.join(SESSIONS_DIR, file), 'utf8'));
      sessions.push({
        id: data.id,
        title: data.title || 'Untitled',
        createdAt: data.createdAt,
        updatedAt: data.updatedAt
      });
    }
  }

  sessions.sort((a, b) => new Date(b.updatedAt) - new Date(a.updatedAt));
  res.json(sessions);
});

app.get('/api/sessions/:id', verifyToken, requireAuth, (req, res) => {
  const session = loadSession(req.params.id);

  if (session) {
    res.json(session);
  } else {
    res.status(404).json({ error: 'Session not found' });
  }
});

app.delete('/api/sessions/:id', verifyToken, requireAuth, (req, res) => {
  const sessionPath = getSessionFilePath(req.params.id);

  if (fs.existsSync(sessionPath)) {
    fs.unlinkSync(sessionPath);
    res.json({ success: true });
  } else {
    res.status(404).json({ error: 'Session not found' });
  }
});

app.put('/api/sessions/:id/title', verifyToken, requireAuth, (req, res) => {
  const { title } = req.body;
  const session = loadSession(req.params.id);

  if (session) {
    session.title = title;
    session.updatedAt = new Date().toISOString();
    saveSession(session);
    res.json({ success: true });
  } else {
    res.status(404).json({ error: 'Session not found' });
  }
});

io.use((socket, next) => {
  requireSocketAuth(socket, next);
});

io.on('connection', (socket) => {
  let sessionId = null;
  let currentSession = null;

  socket.on('load_session', (id) => {
    sessionId = id;
    currentSession = loadSession(id);

    if (currentSession) {
      socket.emit('session_loaded', currentSession);
    }
  });

  socket.on('new_session', () => {
    sessionId = uuidv4();
    currentSession = {
      id: sessionId,
      cliSessionId: uuidv4(),
      title: 'New Conversation',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      messages: []
    };
    saveSession(currentSession);
    socket.emit('session_created', currentSession);
  });

  socket.on('send_message', async (content) => {
    if (!currentSession) return;

    const userMsg = { role: 'user', content, timestamp: new Date().toISOString() };
    currentSession.messages.push(userMsg);

    if (currentSession.messages.length === 1) {
      currentSession.title = content.slice(0, 30) + (content.length > 30 ? '...' : '');
    }

    currentSession.updatedAt = new Date().toISOString();
    saveSession(currentSession);
    socket.emit('message_added', userMsg);

    const assistantMsg = {
      role: 'assistant',
      content: '',
      timestamp: new Date().toISOString()
    };
    currentSession.messages.push(assistantMsg);
    socket.emit('message_added', assistantMsg);

    try {
      const isFirstMessage = currentSession.messages.filter(m => m.role === 'user').length <= 1;
      const args = isFirstMessage
        ? ['-p', content, '--session-id', currentSession.cliSessionId, '--permission-mode', 'auto']
        : ['-p', content, '--resume', currentSession.cliSessionId, '--permission-mode', 'auto'];
      const cli = spawn(CLI_PATH, args, {
        env: process.env
      });

      let fullResponse = '';

      cli.stdout.on('data', (data) => {
        const text = data.toString();
        fullResponse += text;
        assistantMsg.content = fullResponse;
        console.log(`[DEBUG] stdout chunk: ${text.length} bytes, total: ${fullResponse.length}`);
        socket.emit('stream_chunk', text);
      });

      cli.stderr.on('data', (data) => {
        console.log('[DEBUG] stderr:', data.toString());
        socket.emit('stream_error', data.toString());
      });

      cli.on('close', (code) => {
        console.log(`[DEBUG] cli close, code=${code}, response length=${fullResponse.length}`);
        currentSession.updatedAt = new Date().toISOString();
        saveSession(currentSession);
        socket.emit('stream_end', { code, content: fullResponse });
      });

      activeProcesses.set(socket.id, cli);

    } catch (error) {
      socket.emit('stream_error', error.message);
    }
  });

  socket.on('interrupt', () => {
    const cli = activeProcesses.get(socket.id);
    if (cli) {
      cli.kill('SIGINT');
    }
  });

  socket.on('disconnect', () => {
    const cli = activeProcesses.get(socket.id);
    if (cli) {
      cli.kill();
    }
    activeProcesses.delete(socket.id);
  });
});

httpServer.listen(PORT, '0.0.0.0', () => {
  console.log(`Server running on http://0.0.0.0:${PORT}`);
  console.log(`Default user: ${process.env.ADMIN_USERNAME || 'admin'}`);
  console.log(`Please set ADMIN_USERNAME and ADMIN_PASSWORD in .env file`);
});
