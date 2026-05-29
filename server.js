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
const CLI_PROVIDER = (process.env.CLI_PROVIDER || 'claude').toLowerCase();
const CLAUDE_CLI_PATH = process.env.CLAUDE_CLI_PATH || process.env.CLI_PATH || '/root/.nvm/versions/node/v24.14.0/bin/claude';
const CODEX_CLI_PATH = process.env.CODEX_CLI_PATH || '/root/.nvm/versions/node/v24.14.0/bin/codex';

const PROVIDERS = {
  claude: {
    id: 'claude',
    assistantName: 'Claude',
    path: CLAUDE_CLI_PATH
  },
  codex: {
    id: 'codex',
    assistantName: 'Codex',
    path: CODEX_CLI_PATH
  }
};

if (!fs.existsSync(SESSIONS_DIR)) {
  fs.mkdirSync(SESSIONS_DIR, { recursive: true });
}

password.initializeDefaultUser();

const activeProcesses = new Map();
const socketProcesses = new Map();

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

function getProvider(id = CLI_PROVIDER) {
  return PROVIDERS[id] || PROVIDERS.claude;
}

function normalizeProjectDir(projectDir) {
  const dir = (projectDir || process.cwd()).trim() || process.cwd();
  const resolved = path.resolve(dir);
  if (!fs.existsSync(resolved) || !fs.statSync(resolved).isDirectory()) {
    throw new Error(`Project directory not found: ${resolved}`);
  }
  return resolved;
}

function normalizeSessionTitle(title) {
  const value = (title || '').trim();
  return value ? value.slice(0, 80) : 'New Conversation';
}

function buildCliCommand(provider, session, content, isFirstMessage) {
  if (provider.id === 'codex') {
    const baseArgs = ['exec', '--json', '--skip-git-repo-check', '--sandbox', 'danger-full-access', '--cd', session.projectDir];
    if (isFirstMessage || !session.cliSessionId || !session.codexThreadReady) {
      return { command: provider.path, args: [...baseArgs, content] };
    }
    return { command: provider.path, args: ['exec', 'resume', '--json', session.cliSessionId, content] };
  }

  const args = isFirstMessage
    ? ['-p', content, '--session-id', session.cliSessionId, '--permission-mode', 'auto', '--output-format', 'stream-json', '--verbose', '--include-partial-messages']
    : ['-p', content, '--resume', session.cliSessionId, '--permission-mode', 'auto', '--output-format', 'stream-json', '--verbose', '--include-partial-messages'];
  return { command: provider.path, args };
}

function getProcessKey(socketId, targetSessionId) {
  return `${socketId}:${targetSessionId}`;
}

function trackSocketProcess(socketId, key) {
  if (!socketProcesses.has(socketId)) {
    socketProcesses.set(socketId, new Set());
  }
  socketProcesses.get(socketId).add(key);
}

function untrackSocketProcess(socketId, key) {
  const keys = socketProcesses.get(socketId);
  if (!keys) return;
  keys.delete(key);
  if (keys.size === 0) {
    socketProcesses.delete(socketId);
  }
}

app.get('/api/sessions', verifyToken, requireAuth, (req, res) => {
  const sessions = [];

  for (const file of fs.readdirSync(SESSIONS_DIR)) {
    if (file.endsWith('.json')) {
      const data = JSON.parse(fs.readFileSync(path.join(SESSIONS_DIR, file), 'utf8'));
      sessions.push({
        id: data.id,
        title: data.title || 'Untitled',
        provider: data.provider || 'claude',
        assistantName: data.assistantName || getProvider(data.provider).assistantName,
        projectDir: data.projectDir || process.cwd(),
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
    session.title = normalizeSessionTitle(title);
    session.customTitle = true;
    session.updatedAt = new Date().toISOString();
    saveSession(session);
    res.json(session);
  } else {
    res.status(404).json({ error: 'Session not found' });
  }
});

app.post('/api/sessions/:id/copy', verifyToken, requireAuth, (req, res) => {
  const source = loadSession(req.params.id);

  if (!source) {
    res.status(404).json({ error: 'Session not found' });
    return;
  }

  let projectDir;
  try {
    projectDir = normalizeProjectDir(source.projectDir);
  } catch (error) {
    res.status(400).json({ error: error.message });
    return;
  }

  const provider = getProvider(source.provider);
  const now = new Date().toISOString();
  const copiedTitle = normalizeSessionTitle(`${source.title || 'Untitled'} copy`);
  const session = {
    id: uuidv4(),
    cliSessionId: uuidv4(),
    provider: provider.id,
    assistantName: provider.assistantName,
    projectDir,
    title: copiedTitle,
    customTitle: true,
    codexThreadReady: provider.id === 'codex' ? false : undefined,
    createdAt: now,
    updatedAt: now,
    messages: []
  };

  saveSession(session);
  res.status(201).json(session);
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
      socket.emit('session_loaded', {
        ...currentSession,
        isStreaming: activeProcesses.has(getProcessKey(socket.id, currentSession.id))
      });
    }
  });

  socket.on('new_session', (options = {}) => {
    let projectDir;
    try {
      projectDir = normalizeProjectDir(options.projectDir);
    } catch (error) {
      socket.emit('session_error', error.message);
      return;
    }
    const provider = getProvider(options.provider);
    sessionId = uuidv4();
    currentSession = {
      id: sessionId,
      cliSessionId: uuidv4(),
      provider: provider.id,
      assistantName: provider.assistantName,
      projectDir,
      title: normalizeSessionTitle(options.title),
      customTitle: Boolean((options.title || '').trim()),
      codexThreadReady: provider.id === 'codex' ? false : undefined,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      messages: []
    };
    saveSession(currentSession);
    socket.emit('session_created', currentSession);
  });

  socket.on('send_message', async (payload) => {
    const content = typeof payload === 'string' ? payload : payload?.content;
    if (!content) return;
    const targetSessionId = payload?.sessionId || sessionId;
    let streamSession = targetSessionId ? loadSession(targetSessionId) : currentSession;
    if (streamSession) {
      sessionId = streamSession.id;
      currentSession = streamSession;
    }
    if (!streamSession) {
      socket.emit('stream_error', { sessionId: targetSessionId || null, message: 'Session is not loaded. Please select the session again.' });
      return;
    }
    const processKey = getProcessKey(socket.id, streamSession.id);
    if (activeProcesses.has(processKey)) {
      socket.emit('stream_error', { sessionId: streamSession.id, message: 'This session is already streaming.' });
      return;
    }
    streamSession.provider = streamSession.provider || 'claude';
    streamSession.assistantName = getProvider(streamSession.provider).assistantName;
    streamSession.cliSessionId = streamSession.cliSessionId || uuidv4();
    try {
      streamSession.projectDir = normalizeProjectDir(streamSession.projectDir);
    } catch (error) {
      socket.emit('stream_error', { sessionId: streamSession.id, message: error.message });
      return;
    }
    const provider = getProvider(streamSession.provider);

    const userMsg = { role: 'user', content, timestamp: new Date().toISOString() };
    streamSession.messages.push(userMsg);

    if (streamSession.messages.length === 1 && !streamSession.customTitle) {
      streamSession.title = content.slice(0, 30) + (content.length > 30 ? '...' : '');
    }

    streamSession.updatedAt = new Date().toISOString();
    saveSession(streamSession);
    socket.emit('message_added', { sessionId: streamSession.id, message: userMsg });

    const assistantMsg = {
      role: 'assistant',
      content: '',
      thinking: '',
      toolUses: [],
      durationMs: null,
      assistantName: streamSession.assistantName,
      timestamp: new Date().toISOString()
    };
    streamSession.messages.push(assistantMsg);
    socket.emit('message_added', { sessionId: streamSession.id, message: assistantMsg });

    try {
      const isFirstMessage = streamSession.messages.filter(m => m.role === 'user').length <= 1;
      const { command, args } = buildCliCommand(provider, streamSession, content, isFirstMessage);
      let processFailed = false;
      const cli = spawn(command, args, {
        env: process.env,
        cwd: streamSession.projectDir,
        stdio: ['ignore', 'pipe', 'pipe']
      });

      let fullResponse = '';
      let buffer = '';
      let thinking = '';
      let currentTool = null;
      let toolInput = '';
      let resultText = '';
      let resultDurationMs = null;
      let stderrText = '';
      const codexErrors = [];
      const requestStartedAt = Date.now();

      cli.stdout.on('data', (data) => {
        buffer += data.toString();
        const lines = buffer.split('\n');
        buffer = lines.pop();

        for (const line of lines) {
          if (!line.trim()) continue;
          try {
            const event = JSON.parse(line);
            handleStreamEvent(event);
          } catch (e) {
            // 非 JSON 行忽略
          }
        }
      });

      function handleStreamEvent(event) {
        if (provider.id === 'codex') {
          handleCodexEvent(event);
          return;
        }
        handleClaudeEvent(event);
      }

      function handleCodexEvent(event) {
        if (event.type === 'thread.started' && event.thread_id) {
          streamSession.cliSessionId = event.thread_id;
          streamSession.codexThreadReady = true;
          return;
        }

        if (event.type === 'item.completed' && event.item) {
          const item = event.item;
          if (item.type === 'agent_message' && item.text) {
            resultText = item.text;
            fullResponse = item.text;
          } else if (item.type === 'command_execution') {
            const tool = {
              name: 'Bash',
              input: { command: item.command || '' },
              result: (item.aggregated_output || '').substring(0, 2000)
            };
            assistantMsg.toolUses.push(tool);
            socket.emit('stream_tool_use', { sessionId: streamSession.id, name: tool.name, input: tool.input });
            socket.emit('stream_tool_result', { sessionId: streamSession.id, result: tool.result || '(no output)', isError: item.exit_code !== 0 });
          } else if (item.type === 'error' && item.message) {
            codexErrors.push(item.message);
          } else if (item.type) {
            const tool = {
              name: item.type,
              input: item.command ? { command: item.command } : item
            };
            assistantMsg.toolUses.push(tool);
            socket.emit('stream_tool_use', { sessionId: streamSession.id, name: tool.name, input: tool.input });
          }
        }
      }

      function handleClaudeEvent(event) {
        // 捕获 result 事件（最终完整文本）
        if (event.type === 'result' && event.result) {
          resultText = event.result;
          if (typeof event.duration_ms === 'number') {
            resultDurationMs = event.duration_ms;
          } else if (typeof event.durationMs === 'number') {
            resultDurationMs = event.durationMs;
          }
          return;
        }
        // 捕获工具执行结果
        if (event.type === 'user' && event.tool_use_result) {
          const tr = event.tool_use_result;
          const result = tr.stdout || tr.stderr || '';
          // 更新最后一个工具调用的结果
          const lastTool = assistantMsg.toolUses[assistantMsg.toolUses.length - 1];
          if (lastTool) {
            lastTool.result = result.substring(0, 2000);
            socket.emit('stream_tool_result', { sessionId: streamSession.id, result: lastTool.result, isError: tr.is_error });
          }
          return;
        }
        if (event.type !== 'stream_event' || !event.event) return;
        const evt = event.event;

        if (evt.type === 'content_block_start') {
          const block = evt.content_block;
          if (block.type === 'thinking') {
            thinking = '';
            console.log('[STREAM] thinking_start');
            socket.emit('stream_thinking_start', { sessionId: streamSession.id });
          } else if (block.type === 'tool_use') {
            toolInput = '';
            currentTool = { id: block.id, name: block.name };
          }
        } else if (evt.type === 'content_block_delta') {
          const delta = evt.delta;
          if (delta.type === 'thinking_delta') {
            thinking += delta.thinking;
            socket.emit('stream_thinking', { sessionId: streamSession.id, chunk: delta.thinking });
          } else if (delta.type === 'text_delta') {
            fullResponse += delta.text;
            if (fullResponse.length < 50) console.log('[STREAM] text_delta:', delta.text);
            socket.emit('stream_text', { sessionId: streamSession.id, text: delta.text });
          } else if (delta.type === 'input_json_delta') {
            toolInput += delta.partial_json;
          }
        } else if (evt.type === 'content_block_stop') {
          if (currentTool) {
            let input;
            try {
              input = JSON.parse(toolInput);
            } catch (e) {
              input = { raw: toolInput };
            }
            socket.emit('stream_tool_use', { sessionId: streamSession.id, name: currentTool.name, input });
            assistantMsg.toolUses.push({ name: currentTool.name, input });
            currentTool = null;
            toolInput = '';
          }
          if (thinking) {
            assistantMsg.thinking = thinking;
            thinking = '';
          }
        }
      }

      cli.stderr.on('data', (data) => {
        stderrText += data.toString();
      });

      cli.on('error', (error) => {
        processFailed = true;
        assistantMsg.content = `Failed to start ${provider.assistantName}: ${error.message}`;
        assistantMsg.durationMs = Date.now() - requestStartedAt;
        streamSession.updatedAt = new Date().toISOString();
        saveSession(streamSession);
        socket.emit('stream_error', { sessionId: streamSession.id, message: assistantMsg.content });
        activeProcesses.delete(processKey);
        untrackSocketProcess(socket.id, processKey);
      });

      cli.on('close', (code) => {
        if (processFailed) {
          return;
        }
        // 优先用 result 事件的完整文本，否则用累积的 text_delta
        const fallbackError = [...codexErrors, stderrText.trim()].filter(Boolean).join('\n');
        assistantMsg.content = resultText || fullResponse || fallbackError || `Assistant exited with code ${code}`;
        assistantMsg.durationMs = resultDurationMs ?? (Date.now() - requestStartedAt);
        streamSession.updatedAt = new Date().toISOString();
        saveSession(streamSession);
        socket.emit('stream_end', {
          sessionId: streamSession.id,
          code,
          content: assistantMsg.content,
          thinking: assistantMsg.thinking,
          toolUses: assistantMsg.toolUses,
          durationMs: assistantMsg.durationMs,
          assistantName: assistantMsg.assistantName
        });
        activeProcesses.delete(processKey);
        untrackSocketProcess(socket.id, processKey);
      });

      activeProcesses.set(processKey, cli);
      trackSocketProcess(socket.id, processKey);

    } catch (error) {
      socket.emit('stream_error', { sessionId: streamSession?.id || targetSessionId || null, message: error.message });
    }
  });

  socket.on('interrupt', (payload = {}) => {
    const targetSessionId = payload?.sessionId || sessionId;
    const key = targetSessionId ? getProcessKey(socket.id, targetSessionId) : null;
    const cli = key ? activeProcesses.get(key) : null;
    if (cli) {
      cli.kill('SIGINT');
    }
  });

  socket.on('disconnect', () => {
    const keys = socketProcesses.get(socket.id) || new Set();
    for (const key of keys) {
      const cli = activeProcesses.get(key);
      if (cli) {
        cli.kill();
      }
      activeProcesses.delete(key);
    }
    socketProcesses.delete(socket.id);
  });
});

httpServer.listen(PORT, '0.0.0.0', () => {
  console.log(`Server running on http://0.0.0.0:${PORT}`);
  console.log(`CLI provider: ${getProvider().id}`);
  console.log(`Default user: ${process.env.ADMIN_USERNAME || 'admin'}`);
  console.log(`Please set ADMIN_USERNAME and ADMIN_PASSWORD in .env file`);
});
