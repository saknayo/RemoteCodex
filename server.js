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
const CODEX_SESSIONS_DIR = path.join(process.env.HOME || '', '.codex', 'sessions');
const CLI_PROVIDER = (process.env.CLI_PROVIDER || 'claude').toLowerCase();
const CLAUDE_CLI_PATH = process.env.CLAUDE_CLI_PATH || process.env.CLI_PATH || '/root/.nvm/versions/node/v24.14.0/bin/claude';
const CODEX_CLI_PATH = process.env.CODEX_CLI_PATH || '/root/.nvm/versions/node/v24.14.0/bin/codex';
const CODEX_CONTEXT_ARCHIVE_THRESHOLD = Number.parseFloat(process.env.CODEX_CONTEXT_ARCHIVE_THRESHOLD || '0.9');
const CLAUDE_CONTEXT_WINDOW = Number.parseInt(process.env.CLAUDE_CONTEXT_WINDOW || '200000', 10);
const CLAUDE_CONTEXT_ARCHIVE_THRESHOLD = Number.parseFloat(process.env.CLAUDE_CONTEXT_ARCHIVE_THRESHOLD || '0');
const ARCHIVE_COMMAND_TIMEOUT_MS = Number.parseInt(process.env.ARCHIVE_COMMAND_TIMEOUT_MS || '600000', 10);

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
const interruptedProcesses = new Set();
const MAX_FILE_DIFF_CHARS = 20000;
const MAX_SUBAGENT_TEXT_CHARS = 4000;
const CODEX_DEPRECATED_HOOKS_WARNING_RE = /\[features\]\.codex_hooks.*\[features\]\.hooks/i;
const CODEX_EFFORT_VALUES = new Set(['minimal', 'low', 'medium', 'high', 'xhigh']);
const CODEX_EFFORT_ALIASES = {
  min: 'minimal',
  normal: 'medium',
  med: 'medium'
};

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

function isIgnoredCodexDiagnostic(message) {
  return CODEX_DEPRECATED_HOOKS_WARNING_RE.test(message || '');
}

function filterCodexDiagnosticText(text) {
  return (text || '')
    .split(/\r?\n/)
    .filter(line => line.trim() && !isIgnoredCodexDiagnostic(line))
    .join('\n');
}

function truncateToolText(value, maxChars = MAX_SUBAGENT_TEXT_CHARS) {
  const text = typeof value === 'string' ? value : '';
  if (text.length <= maxChars) return text;
  return `${text.slice(0, maxChars)}\n... truncated ...`;
}

function normalizeCodexEffort(value) {
  const normalized = (value || '').trim().toLowerCase();
  const effort = CODEX_EFFORT_ALIASES[normalized] || normalized;
  return CODEX_EFFORT_VALUES.has(effort) ? effort : null;
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

function countUserTurns(messages, startIndex, endIndex) {
  let turns = 0;
  for (let i = startIndex; i < endIndex; i++) {
    if (messages[i]?.role === 'user') {
      turns++;
    }
  }
  return turns;
}

function getMessagePage(session, options = {}) {
  const messages = Array.isArray(session.messages) ? session.messages : [];
  const total = messages.length;
  const before = Number.isInteger(options.before) ? Math.max(0, Math.min(options.before, total)) : total;
  const turns = Number.isInteger(options.turns) ? Math.max(1, Math.min(options.turns, 50)) : 10;
  let start = before;
  let userTurns = 0;

  while (start > 0 && userTurns < turns) {
    start--;
    if (messages[start]?.role === 'user') {
      userTurns++;
    }
  }

  return {
    messages: messages.slice(start, before),
    page: {
      start,
      end: before,
      total,
      hasMore: start > 0,
      loadedTurns: countUserTurns(messages, start, before)
    }
  };
}

function buildSessionPayload(session, options = {}) {
  const { messages, page } = getMessagePage(session, options);
  return {
    ...session,
    messages,
    messagePage: page
  };
}

function buildCliCommand(provider, session, content, isFirstMessage) {
  if (provider.id === 'codex') {
    const baseArgs = ['exec', '--json', '--skip-git-repo-check', '--sandbox', 'danger-full-access', '--cd', session.projectDir];
    if (session.codexEffort) {
      baseArgs.push('-c', `model_reasoning_effort="${session.codexEffort}"`);
    }
    if (isFirstMessage || !session.cliSessionId || !session.codexThreadReady) {
      return { command: provider.path, args: [...baseArgs, '-'], stdin: content };
    }
    return { command: provider.path, args: [...baseArgs, 'resume', session.cliSessionId, '-'], stdin: content };
  }

  // isFirstMessage 用 --session-id 创建；归档后会生成新 cliSessionId 且 cliSessionReady=false，需重新用 --session-id
  const needsNewSession = isFirstMessage || session.cliSessionReady === false || !session.cliSessionId;
  const args = needsNewSession
    ? ['-p', content, '--session-id', session.cliSessionId, '--permission-mode', 'auto', '--output-format', 'stream-json', '--verbose', '--include-partial-messages']
    : ['-p', content, '--resume', session.cliSessionId, '--permission-mode', 'auto', '--output-format', 'stream-json', '--verbose', '--include-partial-messages'];
  return { command: provider.path, args };
}

function findCodexRolloutFile(threadId) {
  if (!threadId || !fs.existsSync(CODEX_SESSIONS_DIR)) return null;
  const stack = [CODEX_SESSIONS_DIR];
  const suffix = `${threadId}.jsonl`;

  while (stack.length) {
    const dir = stack.pop();
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }

    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        stack.push(fullPath);
      } else if (entry.isFile() && entry.name.endsWith(suffix)) {
        return fullPath;
      }
    }
  }

  return null;
}

function getCodexContextUsage(threadId) {
  const filePath = findCodexRolloutFile(threadId);
  if (!filePath) return null;

  let latest = null;
  const lines = fs.readFileSync(filePath, 'utf8').split(/\r?\n/);
  for (const line of lines) {
    if (!line.trim()) continue;
    let record;
    try {
      record = JSON.parse(line);
    } catch {
      continue;
    }

    const payload = record.payload || {};
    if (payload.type !== 'token_count' || !payload.info) continue;
    const contextTokens = Number(payload.info.last_token_usage?.total_tokens);
    const totalTokens = Number(payload.info.total_token_usage?.total_tokens);
    const contextWindow = Number(payload.info.model_context_window);
    if (!Number.isFinite(contextTokens) || !Number.isFinite(contextWindow) || contextWindow <= 0) continue;

    latest = {
      contextTokens,
      totalTokens,
      contextWindow,
      ratio: contextTokens / contextWindow,
      totalTokenUsage: payload.info.total_token_usage || null,
      lastTokenUsage: payload.info.last_token_usage || null,
      rolloutFile: filePath,
      timestamp: record.timestamp || null
    };
  }

  return latest;
}

function buildContextUsagePayload(usage) {
  if (!isValidContextUsage(usage)) return null;
  return {
    contextTokens: usage.contextTokens,
    totalTokens: usage.totalTokens,
    contextWindow: usage.contextWindow,
    ratio: usage.ratio,
    percent: Math.round(usage.ratio * 100)
  };
}

function isValidContextUsage(usage) {
  return Boolean(
    usage &&
    Number.isFinite(usage.contextTokens) &&
    Number.isFinite(usage.contextWindow) &&
    Number.isFinite(usage.ratio) &&
    usage.contextTokens >= 0 &&
    usage.contextWindow > 0 &&
    usage.ratio >= 0 &&
    usage.ratio <= 1
  );
}

function getClaudeContextUsage(usage, modelUsage) {
  if (!usage || typeof usage !== 'object') return null;
  const input = Number(usage.input_tokens) || 0;
  const output = Number(usage.output_tokens) || 0;
  const cacheCreation = Number(usage.cache_creation_input_tokens) || 0;
  const cacheRead = Number(usage.cache_read_input_tokens) || 0;

  // 优先从 modelUsage 读取真实 context window（不同模型窗口不同，如 glm-5.1[1m] 为 1M）
  let contextWindow = null;
  if (modelUsage && typeof modelUsage === 'object') {
    for (const model of Object.values(modelUsage)) {
      const window = Number(model?.contextWindow);
      if (Number.isFinite(window) && window > 0) {
        contextWindow = window;
        break;
      }
    }
  }
  if (!contextWindow && Number.isFinite(CLAUDE_CONTEXT_WINDOW) && CLAUDE_CONTEXT_WINDOW > 0) {
    contextWindow = CLAUDE_CONTEXT_WINDOW;
  }
  if (!contextWindow) contextWindow = 200000;

  // 当前窗口占用 = 提示侧 token（含缓存）+ 生成 token
  const contextTokens = input + cacheCreation + cacheRead + output;
  if (!Number.isFinite(contextTokens) || contextTokens < 0) return null;
  const ratio = contextTokens / contextWindow;
  return {
    contextTokens,
    totalTokens: contextTokens,
    contextWindow,
    ratio,
    totalTokenUsage: { input_tokens: input, output_tokens: output, cache_creation_input_tokens: cacheCreation, cache_read_input_tokens: cacheRead },
    lastTokenUsage: null,
    rolloutFile: null,
    timestamp: null
  };
}

function shouldArchiveCodexContext(session, isFirstMessage) {
  if (session.provider !== 'codex' || isFirstMessage || !session.cliSessionId || !session.codexThreadReady) {
    return { shouldArchive: false, usage: null };
  }

  const usage = getCodexContextUsage(session.cliSessionId);
  return {
    shouldArchive: Boolean(isValidContextUsage(usage) && usage.ratio >= CODEX_CONTEXT_ARCHIVE_THRESHOLD),
    usage: isValidContextUsage(usage) ? usage : null
  };
}

function buildCodexArchivePrompt(usage) {
  const percent = usage ? Math.round(usage.ratio * 100) : 'unknown';
  return [
    '请先暂停处理新的用户需求，执行本项目既有的归档机制。',
    '',
    `当前 Codex session 上下文使用量已达到 ${percent}%，需要先归档近期对话和当前工作状态，避免后续 compact 丢失目标或上下文。`,
    '',
    '要求：',
    '1. 按项目规则查找并使用项目自己的归档/恢复机制。',
    '2. 记录当前目标、已完成事项、未完成事项、关键设计决策、验证结果和下一步建议。',
    '3. 不要新建 RemoteCodex 内部归档文件；只使用项目已有归档机制。',
    '4. 归档完成后，用一句话说明归档已完成。'
  ].join('\n');
}

function runCliCommand(command, args, stdin, cwd, timeoutMs = ARCHIVE_COMMAND_TIMEOUT_MS) {
  return new Promise((resolve) => {
    const child = spawn(command, args, {
      env: process.env,
      cwd,
      stdio: [stdin ? 'pipe' : 'ignore', 'pipe', 'pipe']
    });

    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let settled = false;
    const safeTimeoutMs = Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : 0;
    const killTimer = safeTimeoutMs ? setTimeout(() => {
      timedOut = true;
      stderr += stderr ? '\n' : '';
      stderr += `Archive command timed out after ${safeTimeoutMs}ms`;
      child.kill('SIGTERM');
      setTimeout(() => {
        if (!settled) child.kill('SIGKILL');
      }, 5000).unref();
    }, safeTimeoutMs) : null;
    killTimer?.unref();

    child.stdout.on('data', (data) => {
      stdout += data.toString();
    });
    child.stderr.on('data', (data) => {
      stderr += data.toString();
    });
    child.on('error', (error) => {
      if (settled) return;
      settled = true;
      if (killTimer) clearTimeout(killTimer);
      resolve({ code: null, stdout, stderr: error.message, timedOut });
    });
    child.on('close', (code) => {
      if (settled) return;
      settled = true;
      if (killTimer) clearTimeout(killTimer);
      resolve({ code, stdout, stderr, timedOut });
    });

    if (stdin) {
      child.stdin.on('error', () => {});
      child.stdin.end(stdin);
    }
  });
}

async function archiveCodexContextBeforeRotation(provider, session, usage) {
  const oldThreadId = session.cliSessionId;
  const archivePrompt = buildCodexArchivePrompt(usage);
  const { command, args, stdin } = buildCliCommand(provider, session, archivePrompt, false);
  const result = await runCliCommand(command, args, stdin, session.projectDir);
  const now = new Date().toISOString();
  session.codexThreadHistory = Array.isArray(session.codexThreadHistory) ? session.codexThreadHistory : [];
  session.codexThreadHistory.push({
    threadId: oldThreadId,
    archivedAt: now,
    reason: 'context_usage_threshold',
    contextTokens: usage?.contextTokens ?? null,
    totalTokens: usage?.totalTokens ?? null,
    contextWindow: usage?.contextWindow ?? null,
    ratio: usage?.ratio ?? null,
    archiveExitCode: result.code,
    archiveTimedOut: Boolean(result.timedOut)
  });
  session.previousCodexThreadId = oldThreadId;
  session.cliSessionId = uuidv4();
  session.codexThreadReady = false;
  session.updatedAt = now;
  return result;
}

function rotateCodexSessionForClear(session) {
  const oldThreadId = session.cliSessionId || null;
  const oldThreadReady = Boolean(session.codexThreadReady && oldThreadId);
  const now = new Date().toISOString();

  if (oldThreadReady) {
    session.codexThreadHistory = Array.isArray(session.codexThreadHistory) ? session.codexThreadHistory : [];
    session.codexThreadHistory.push({
      threadId: oldThreadId,
      archivedAt: now,
      reason: 'manual_clear',
      contextTokens: null,
      totalTokens: null,
      contextWindow: null,
      ratio: null,
      archiveExitCode: null,
      archiveTimedOut: false
    });
    session.previousCodexThreadId = oldThreadId;
  }

  session.cliSessionId = uuidv4();
  session.codexThreadReady = false;
  session.updatedAt = now;

  return {
    oldThreadId,
    oldThreadReady,
    newCliSessionId: session.cliSessionId
  };
}

function shouldArchiveClaudeContext(session, isFirstMessage) {
  if (session.provider !== 'claude' || isFirstMessage) {
    return { shouldArchive: false, usage: null };
  }
  if (!Number.isFinite(CLAUDE_CONTEXT_ARCHIVE_THRESHOLD) || CLAUDE_CONTEXT_ARCHIVE_THRESHOLD <= 0) {
    return { shouldArchive: false, usage: null };
  }

  const lastAssistant = [...(session.messages || [])].reverse().find(message => message.role === 'assistant');
  const usage = lastAssistant?.contextUsage;
  return {
    shouldArchive: Boolean(isValidContextUsage(usage) && usage.ratio >= CLAUDE_CONTEXT_ARCHIVE_THRESHOLD),
    usage: isValidContextUsage(usage) ? usage : null
  };
}

function buildClaudeArchivePrompt(usage) {
  const percent = usage ? Math.round(usage.ratio * 100) : 'unknown';
  return [
    '请先暂停处理新的用户需求，执行本项目既有的归档机制。',
    '',
    `当前 Claude session 上下文使用量已达到 ${percent}%，需要先归档近期对话和当前工作状态，避免后续上下文溢出丢失目标。`,
    '',
    '要求：',
    '1. 按项目规则查找并使用项目自己的归档/恢复机制。',
    '2. 记录当前目标、已完成事项、未完成事项、关键设计决策、验证结果和下一步建议。',
    '3. 不要新建 RemoteCodex 内部归档文件；只使用项目已有归档机制。',
    '4. 归档完成后，用一句话说明归档已完成。'
  ].join('\n');
}

async function archiveClaudeContextBeforeRotation(provider, session, usage) {
  const oldCliSessionId = session.cliSessionId;
  const archivePrompt = buildClaudeArchivePrompt(usage);
  // 归档提示发给当前 Claude session（resume 模式），让模型总结当前工作
  const archiveCmd = buildCliCommand(provider, session, archivePrompt, false);
  const result = await runCliCommand(archiveCmd.command, archiveCmd.args, archiveCmd.stdin || null, session.projectDir);
  const now = new Date().toISOString();
  session.claudeSessionHistory = Array.isArray(session.claudeSessionHistory) ? session.claudeSessionHistory : [];
  session.claudeSessionHistory.push({
    cliSessionId: oldCliSessionId,
    archivedAt: now,
    reason: 'context_usage_threshold',
    contextTokens: usage?.contextTokens ?? null,
    contextWindow: usage?.contextWindow ?? null,
    ratio: usage?.ratio ?? null,
    archiveExitCode: result.code,
    archiveTimedOut: Boolean(result.timedOut)
  });
  session.previousCliSessionId = oldCliSessionId;
  session.cliSessionId = uuidv4();
  session.cliSessionReady = false;
  session.updatedAt = now;
  return result;
}

function rotateClaudeSessionForClear(session) {
  const oldCliSessionId = session.cliSessionId || null;
  const oldSessionReady = Boolean(session.cliSessionReady !== false && oldCliSessionId);
  const now = new Date().toISOString();

  if (oldSessionReady) {
    session.claudeSessionHistory = Array.isArray(session.claudeSessionHistory) ? session.claudeSessionHistory : [];
    session.claudeSessionHistory.push({
      cliSessionId: oldCliSessionId,
      archivedAt: now,
      reason: 'manual_clear',
      contextTokens: null,
      contextWindow: null,
      ratio: null,
      archiveExitCode: null,
      archiveTimedOut: false
    });
    session.previousCliSessionId = oldCliSessionId;
  }

  session.cliSessionId = uuidv4();
  session.cliSessionReady = false;
  session.updatedAt = now;

  return {
    oldCliSessionId,
    oldSessionReady,
    newCliSessionId: session.cliSessionId
  };
}

function formatTokenCount(value) {
  return Number.isFinite(Number(value)) ? Number(value).toLocaleString('en-US') : 'unknown';
}

function formatUsagePercent(ratio) {
  return Number.isFinite(Number(ratio)) ? `${Math.round(Number(ratio) * 100)}%` : 'unknown';
}

function buildCodexContextStatusLines(session) {
  if (session.provider !== 'codex') {
    return [];
  }

  const thresholdPercent = formatUsagePercent(CODEX_CONTEXT_ARCHIVE_THRESHOLD);
  if (!session.cliSessionId || !session.codexThreadReady) {
    return [
      '',
      'Context usage:',
      '- Status: unavailable, Codex thread is not initialized',
      `- Archive threshold: ${thresholdPercent}`
    ];
  }

  const usage = getCodexContextUsage(session.cliSessionId);
  if (!usage) {
    return [
      '',
      'Context usage:',
      '- Status: unavailable, no Codex token_count event found for this thread',
      `- Archive threshold: ${thresholdPercent}`
    ];
  }

  const valid = isValidContextUsage(usage);
  return [
    '',
    'Context usage:',
    `- Status: ${valid ? 'valid' : 'ignored, raw ratio is outside 0%-100%'}`,
    `- Current window tokens: ${formatTokenCount(usage.contextTokens)} / ${formatTokenCount(usage.contextWindow)}`,
    `- Current window usage: ${valid ? formatUsagePercent(usage.ratio) : 'unknown'}`,
    `- Raw usage ratio: ${formatUsagePercent(usage.ratio)}`,
    `- Archive threshold: ${thresholdPercent}`,
    `- Total thread tokens: ${formatTokenCount(usage.totalTokens)}`,
    `- Last token event: ${usage.timestamp || 'unknown'}`
  ];
}

function buildCodexStatusMessage(session, isStreaming) {
  const messages = Array.isArray(session.messages) ? session.messages : [];
  const userTurns = messages.filter(message => message.role === 'user').length;
  const assistantMessages = messages.filter(message => message.role === 'assistant').length;
  const lastUpdated = session.updatedAt ? new Date(session.updatedAt).toLocaleString('zh-CN') : 'unknown';

  return [
    '# Codex Status',
    '',
    `- Provider: ${session.provider || 'codex'}`,
    `- Assistant: ${session.assistantName || 'Codex'}`,
    `- Project directory: ${session.projectDir || process.cwd()}`,
    `- Codex thread: ${session.codexThreadReady ? 'ready' : 'not initialized'}`,
    `- Reasoning effort: ${session.codexEffort || 'default'}`,
    `- Active response: ${isStreaming ? 'yes' : 'no'}`,
    `- Messages: ${messages.length}`,
    `- User turns: ${userTurns}`,
    `- Assistant messages: ${assistantMessages}`,
    `- Last updated: ${lastUpdated}`,
    ...buildCodexContextStatusLines(session),
    '',
    'Supported web slash commands: `/status`, `/clear`, `/effort [minimal|low|medium|high|xhigh]`'
  ].join('\n');
}

function buildClaudeStatusMessage(session, isStreaming) {
  const messages = Array.isArray(session.messages) ? session.messages : [];
  const userTurns = messages.filter(message => message.role === 'user').length;
  const assistantMessages = messages.filter(message => message.role === 'assistant').length;
  const lastUpdated = session.updatedAt ? new Date(session.updatedAt).toLocaleString('zh-CN') : 'unknown';

  const lines = [
    '# Claude Status',
    '',
    `- Provider: ${session.provider || 'claude'}`,
    `- Assistant: ${session.assistantName || 'Claude'}`,
    `- Project directory: ${session.projectDir || process.cwd()}`,
    `- Active response: ${isStreaming ? 'yes' : 'no'}`,
    `- Messages: ${messages.length}`,
    `- User turns: ${userTurns}`,
    `- Assistant messages: ${assistantMessages}`,
    `- Last updated: ${lastUpdated}`
  ];

  // 取最近一条 assistant 消息的上下文用量
  const lastAssistant = [...messages].reverse().find(message => message.role === 'assistant');
  const usage = lastAssistant?.contextUsage;
  const thresholdPercent = formatUsagePercent(CLAUDE_CONTEXT_ARCHIVE_THRESHOLD);
  const archiveHistory = Array.isArray(session.claudeSessionHistory) ? session.claudeSessionHistory : [];
  lines.push('', 'Context usage:');
  if (isValidContextUsage(usage)) {
    lines.push(
      `- Current window tokens: ${formatTokenCount(usage.contextTokens)} / ${formatTokenCount(usage.contextWindow)}`,
      `- Current window usage: ${formatUsagePercent(usage.ratio)}`,
      `- Archive threshold: ${thresholdPercent}`
    );
  } else {
    lines.push(
      '- Status: unavailable, no valid usage recorded yet for this session',
      `- Archive threshold: ${thresholdPercent}`
    );
  }
  lines.push(`- Archive history: ${archiveHistory.length} archived session(s)`);
  if (session.previousCliSessionId) {
    lines.push(`- Previous session id: ${session.previousCliSessionId}`);
  }

  lines.push('', 'Supported web slash commands: `/status`, `/clear`');
  return lines.join('\n');
}

function buildLocalCommandResponse(provider, session, content, isStreaming) {
  const trimmed = content.trim();
  if (!trimmed.startsWith('/')) {
    return null;
  }

  const command = trimmed.split(/\s+/, 1)[0].toLowerCase();

  if (command === '/status') {
    return provider.id === 'codex'
      ? buildCodexStatusMessage(session, isStreaming)
      : buildClaudeStatusMessage(session, isStreaming);
  }

  if (command === '/clear') {
    if (provider.id === 'codex') {
      const result = rotateCodexSessionForClear(session);
      return [
        '# Codex Session Cleared',
        '',
        'Opened a new Codex session for this Web conversation.',
        result.oldThreadReady
          ? 'The previous Codex thread id was saved to this session history.'
          : 'No initialized Codex thread was active, so only a fresh Codex session was prepared.',
        '',
        'Your visible chat history is unchanged. The next message will start a new Codex thread.'
      ].join('\n');
    }

    const result = rotateClaudeSessionForClear(session);
    return [
      '# Claude Session Cleared',
      '',
      'Opened a new Claude CLI session for this Web conversation.',
      result.oldSessionReady
        ? 'The previous Claude session id was saved to this session history.'
        : 'No initialized Claude session was active, so only a fresh Claude session was prepared.',
      '',
      'Your visible chat history is unchanged. The next message will start a new Claude CLI session.'
    ].join('\n');
  }

  if (provider.id === 'codex') {
    if (command === '/effort') {
      const value = trimmed.split(/\s+/)[1];
      if (!value) {
        return [
          '# Codex Effort',
          '',
          `Current reasoning effort: ${session.codexEffort || 'default'}`,
          '',
          'Usage: `/effort minimal|low|medium|high|xhigh`'
        ].join('\n');
      }

      const effort = normalizeCodexEffort(value);
      if (!effort) {
        return [
          `Unsupported Codex effort: \`${value}\``,
          '',
          'Supported values: `minimal`, `low`, `medium`, `high`, `xhigh`.'
        ].join('\n');
      }

      session.codexEffort = effort;
      return [
        '# Codex Effort',
        '',
        `Reasoning effort set to: ${effort}`,
        '',
        'This setting is stored on the current session and will be applied to subsequent Codex requests.'
      ].join('\n');
    }

    return [
      `Unsupported Codex slash command: \`${command}\``,
      '',
      'Remote Codex currently supports `/status`, `/clear`, and `/effort [minimal|low|medium|high|xhigh]` for Codex sessions.',
      'Other Codex TUI slash commands are not available through the non-interactive `codex exec` bridge yet.'
    ].join('\n');
  }

  return [
    `Unsupported Claude slash command: \`${command}\``,
    '',
    'Remote Codex currently supports `/status` and `/clear` for Claude sessions.',
    'Other Claude CLI slash commands are not available through the non-interactive `-p` bridge yet.'
  ].join('\n');
}

function buildCodexCollabTool(item) {
  const agentStates = item.agents_states && typeof item.agents_states === 'object' ? item.agents_states : {};
  const agents = Object.entries(agentStates).map(([threadId, state]) => ({
    threadId,
    status: state?.status || 'unknown',
    message: truncateToolText(state?.message)
  }));

  return {
    id: item.id,
    name: 'Subagents',
    input: {
      type: 'collab_tool_call',
      action: item.tool || 'agent',
      status: item.status || 'unknown',
      prompt: truncateToolText(item.prompt, 2000),
      receiverThreadIds: Array.isArray(item.receiver_thread_ids) ? item.receiver_thread_ids : [],
      agents
    }
  };
}

function applyToolTiming(tool, startedAt, endedAt = null) {
  const startTime = Date.parse(startedAt);
  const endTime = endedAt ? Date.parse(endedAt) : NaN;
  return {
    ...tool,
    startedAt,
    endedAt,
    durationMs: Number.isFinite(startTime) && Number.isFinite(endTime) ? Math.max(0, endTime - startTime) : null
  };
}

function upsertToolUse(toolUses, tool) {
  const index = tool.id ? toolUses.findIndex(existing => existing.id === tool.id) : -1;
  if (index >= 0) {
    toolUses[index] = {
      ...tool,
      startedAt: tool.startedAt || toolUses[index].startedAt || null,
      endedAt: tool.endedAt || toolUses[index].endedAt || null,
      durationMs: tool.durationMs ?? toolUses[index].durationMs ?? null
    };
    return { tool: toolUses[index], updated: true };
  }
  toolUses.push(tool);
  return { tool, updated: false };
}

function finalizePendingToolTimings(toolUses, endedAt) {
  for (const tool of toolUses) {
    if (tool.name === 'Subagents' && tool.input?.type === 'collab_tool_call' && tool.input.status === 'in_progress') {
      tool.input.status = 'incomplete';
    }
    if (tool.startedAt && !tool.endedAt) {
      Object.assign(tool, applyToolTiming(tool, tool.startedAt, endedAt));
    }
  }
}

function isSafeRelativePath(filePath) {
  if (!filePath || path.isAbsolute(filePath)) return false;
  const normalized = path.normalize(filePath);
  return normalized !== '..' && !normalized.startsWith(`..${path.sep}`);
}

function collectCommandOutput(command, args, cwd, maxChars = MAX_FILE_DIFF_CHARS) {
  const child = spawn(command, args, {
    cwd,
    env: process.env,
    stdio: ['ignore', 'pipe', 'ignore']
  });

  let output = '';
  child.stdout.on('data', (data) => {
    if (output.length >= maxChars) return;
    output += data.toString();
    if (output.length > maxChars) {
      output = `${output.slice(0, maxChars)}\n... diff truncated ...`;
    }
  });

  return new Promise((resolve) => {
    child.on('error', () => resolve(''));
    child.on('close', () => resolve(output));
  });
}

async function collectGitDiffForFile(projectDir, filePath, kind = '') {
  if (!isSafeRelativePath(filePath)) return '';

  const diff = await collectCommandOutput('git', ['diff', '--no-ext-diff', '--', filePath], projectDir);
  if (diff || kind !== 'add') {
    return diff;
  }

  const projectRoot = path.resolve(projectDir);
  const absolutePath = path.resolve(projectRoot, filePath);
  if (!absolutePath.startsWith(`${projectRoot}${path.sep}`) || !fs.existsSync(absolutePath)) {
    return '';
  }

  return collectCommandOutput('git', ['diff', '--no-index', '--', '/dev/null', filePath], projectDir);
}

async function enrichFileChangeTool(tool, projectDir) {
  const changes = Array.isArray(tool.input?.changes) ? tool.input.changes : [];
  if (!changes.length) return tool;

  const enrichedChanges = await Promise.all(changes.map(async (change) => ({
    ...change,
    diff: change.diff || await collectGitDiffForFile(projectDir, change.path, change.kind)
  })));

  return {
    ...tool,
    input: {
      ...tool.input,
      changes: enrichedChanges
    }
  };
}

async function enrichMissingFileChangeDiffs(toolUses, projectDir) {
  for (let index = 0; index < toolUses.length; index++) {
    const tool = toolUses[index];
    const isFileChange = tool.name === 'file_change' || tool.input?.type === 'file_change';
    const hasMissingDiff = Array.isArray(tool.input?.changes) && tool.input.changes.some(change => !change.diff);
    if (isFileChange && hasMissingDiff) {
      toolUses[index] = await enrichFileChangeTool(tool, projectDir);
    }
  }
}

const CLAUDE_FILE_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);

function getClaudeToolFilePath(tool) {
  if (!tool.input || typeof tool.input !== 'object') return null;
  return tool.input.file_path || tool.input.notebook_path || null;
}

async function enrichClaudeFileDiffs(toolUses, projectDir) {
  for (let index = 0; index < toolUses.length; index++) {
    const tool = toolUses[index];
    if (!CLAUDE_FILE_TOOLS.has(tool.name)) continue;
    const filePath = getClaudeToolFilePath(tool);
    if (!filePath) continue;
    const kind = tool.name === 'Write' ? 'add' : '';
    tool.diff = await collectGitDiffForFile(projectDir, filePath, kind);
  }
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
    res.json(buildSessionPayload(session));
  } else {
    res.status(404).json({ error: 'Session not found' });
  }
});

app.get('/api/sessions/:id/messages', verifyToken, requireAuth, (req, res) => {
  const session = loadSession(req.params.id);

  if (!session) {
    res.status(404).json({ error: 'Session not found' });
    return;
  }

  const before = Number.parseInt(req.query.before, 10);
  const turns = Number.parseInt(req.query.turns, 10);
  res.json(getMessagePage(session, {
    before: Number.isFinite(before) ? before : undefined,
    turns: Number.isFinite(turns) ? turns : undefined
  }));
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
    res.json(buildSessionPayload(session));
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
        ...buildSessionPayload(currentSession),
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

    const localResponse = buildLocalCommandResponse(provider, streamSession, content, activeProcesses.has(processKey));
    if (localResponse) {
      const assistantMsg = {
        role: 'assistant',
        content: localResponse,
        thinking: '',
        thinkingMeta: null,
        toolUses: [],
        durationMs: 0,
        assistantName: streamSession.assistantName,
        timestamp: new Date().toISOString()
      };
      streamSession.messages.push(assistantMsg);
      streamSession.updatedAt = new Date().toISOString();
      saveSession(streamSession);
      socket.emit('message_added', { sessionId: streamSession.id, message: assistantMsg });
      socket.emit('stream_end', {
        sessionId: streamSession.id,
        code: 0,
        content: assistantMsg.content,
        thinking: assistantMsg.thinking,
        thinkingMeta: assistantMsg.thinkingMeta,
        toolUses: assistantMsg.toolUses,
        durationMs: assistantMsg.durationMs,
        assistantName: assistantMsg.assistantName
      });
      return;
    }

    const assistantMsg = {
      role: 'assistant',
      content: '',
      thinking: '',
      thinkingMeta: null,
      toolUses: [],
      durationMs: null,
      interrupted: false,
      assistantName: streamSession.assistantName,
      timestamp: new Date().toISOString()
    };
    streamSession.messages.push(assistantMsg);
    socket.emit('message_added', { sessionId: streamSession.id, message: assistantMsg });

    try {
      const isFirstMessage = streamSession.messages.filter(m => m.role === 'user').length <= 1;
      if (provider.id === 'codex') {
        const archiveCheck = shouldArchiveCodexContext(streamSession, isFirstMessage);
        if (archiveCheck.shouldArchive) {
          const archiveMsg = {
            role: 'system',
            content: `Codex context usage reached ${Math.round(archiveCheck.usage.ratio * 100)}%. 正在归档当前 Codex session，然后会切换到新的 Codex session 继续处理你的消息。`,
            timestamp: new Date().toISOString()
          };
          streamSession.messages.splice(streamSession.messages.length - 1, 0, archiveMsg);
          streamSession.updatedAt = new Date().toISOString();
          saveSession(streamSession);
          socket.emit('message_added', { sessionId: streamSession.id, message: archiveMsg });
          const archiveResult = await archiveCodexContextBeforeRotation(provider, streamSession, archiveCheck.usage);
          const systemMsg = {
            role: 'system',
            content: archiveResult.code === 0
              ? `归档完成。已开启新的 Codex session，原 Codex session id 已保存到历史记录。`
              : `归档命令退出码 ${archiveResult.code ?? 'unknown'}。仍会开启新的 Codex session，原 Codex session id 已保存到历史记录。`,
            timestamp: new Date().toISOString()
          };
          streamSession.messages.splice(streamSession.messages.length - 1, 0, systemMsg);
          streamSession.updatedAt = new Date().toISOString();
          saveSession(streamSession);
          socket.emit('message_added', { sessionId: streamSession.id, message: systemMsg });
        }
      } else if (provider.id === 'claude') {
        const archiveCheck = shouldArchiveClaudeContext(streamSession, isFirstMessage);
        if (archiveCheck.shouldArchive) {
          const archiveMsg = {
            role: 'system',
            content: `Claude context usage reached ${Math.round(archiveCheck.usage.ratio * 100)}%. 正在归档当前 Claude session，然后会切换到新的 Claude session 继续处理你的消息。`,
            timestamp: new Date().toISOString()
          };
          streamSession.messages.splice(streamSession.messages.length - 1, 0, archiveMsg);
          streamSession.updatedAt = new Date().toISOString();
          saveSession(streamSession);
          socket.emit('message_added', { sessionId: streamSession.id, message: archiveMsg });
          const archiveResult = await archiveClaudeContextBeforeRotation(provider, streamSession, archiveCheck.usage);
          const systemMsg = {
            role: 'system',
            content: archiveResult.code === 0
              ? `归档完成。已开启新的 Claude session，原 Claude session id 已保存到历史记录。`
              : `归档命令退出码 ${archiveResult.code ?? 'unknown'}。仍会开启新的 Claude session，原 Claude session id 已保存到历史记录。`,
            timestamp: new Date().toISOString()
          };
          streamSession.messages.splice(streamSession.messages.length - 1, 0, systemMsg);
          streamSession.updatedAt = new Date().toISOString();
          saveSession(streamSession);
          socket.emit('message_added', { sessionId: streamSession.id, message: systemMsg });
        }
      }
      const { command, args, stdin } = buildCliCommand(provider, streamSession, content, isFirstMessage);
      let processFailed = false;
      const cli = spawn(command, args, {
        env: process.env,
        cwd: streamSession.projectDir,
        stdio: [stdin ? 'pipe' : 'ignore', 'pipe', 'pipe']
      });

      if (stdin) {
        cli.stdin.on('error', () => {});
        cli.stdin.end(stdin);
      }

      let fullResponse = '';
      let buffer = '';
      let thinking = '';
      let thinkingStartedAt = null;
      let currentTool = null;
      let toolInput = '';
      let resultText = '';
      let resultDurationMs = null;
      let claudeUsage = null;
      let claudeModelUsage = null;
      let stderrText = '';
      const codexErrors = [];
      const streamEventTasks = [];
      const requestStartedAt = Date.now();

      function pushCodexError(message) {
        if (!message || isIgnoredCodexDiagnostic(message) || codexErrors.includes(message)) {
          return;
        }
        codexErrors.push(message);
      }

      cli.stdout.on('data', (data) => {
        buffer += data.toString();
        const lines = buffer.split('\n');
        buffer = lines.pop();

        for (const line of lines) {
          if (!line.trim()) continue;
          try {
            const event = JSON.parse(line);
            streamEventTasks.push(handleStreamEvent(event));
          } catch (e) {
            // 非 JSON 行忽略
          }
        }
      });

      async function handleStreamEvent(event) {
        if (provider.id === 'codex') {
          await handleCodexEvent(event);
          return;
        }
        handleClaudeEvent(event);
      }

      async function handleCodexEvent(event) {
        if (event.type === 'thread.started' && event.thread_id) {
          streamSession.cliSessionId = event.thread_id;
          streamSession.codexThreadReady = true;
          return;
        }

        if (event.type === 'error' && event.message) {
          pushCodexError(event.message);
          return;
        }

        if (event.type === 'turn.failed' && event.error?.message) {
          pushCodexError(event.error.message);
          return;
        }

        if ((event.type === 'item.started' || event.type === 'item.completed') && event.item?.type === 'collab_tool_call') {
          const now = new Date().toISOString();
          const existing = assistantMsg.toolUses.find(tool => tool.id && tool.id === event.item.id);
          const tool = applyToolTiming(
            buildCodexCollabTool(event.item),
            existing?.startedAt || now,
            event.type === 'item.completed' ? now : null
          );
          const { updated } = upsertToolUse(assistantMsg.toolUses, tool);
          const eventName = updated ? 'stream_tool_update' : 'stream_tool_use';
          socket.emit(eventName, { sessionId: streamSession.id, ...tool });
          return;
        }

        if (event.type === 'item.completed' && event.item) {
          const item = event.item;
          if (item.type === 'agent_message' && item.text) {
            resultText = item.text;
            fullResponse = item.text;
          } else if (item.type === 'command_execution') {
            const now = new Date().toISOString();
            const tool = applyToolTiming({
              name: 'Bash',
              input: { command: item.command || '' },
              result: (item.aggregated_output || '').substring(0, 2000)
            }, now, now);
            assistantMsg.toolUses.push(tool);
            socket.emit('stream_tool_use', { sessionId: streamSession.id, ...tool });
            socket.emit('stream_tool_result', { sessionId: streamSession.id, result: tool.result || '(no output)', isError: item.exit_code !== 0, endedAt: tool.endedAt, durationMs: tool.durationMs });
          } else if (item.type === 'error' && item.message) {
            pushCodexError(item.message);
          } else if (item.type) {
            const now = new Date().toISOString();
            let tool = applyToolTiming({
              name: item.type,
              input: item.command ? { command: item.command } : item
            }, now, now);
            if (tool.name === 'file_change' || tool.input?.type === 'file_change') {
              tool = await enrichFileChangeTool(tool, streamSession.projectDir);
            }
            assistantMsg.toolUses.push(tool);
            socket.emit('stream_tool_use', { sessionId: streamSession.id, ...tool });
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
          if (event.usage && typeof event.usage === 'object') {
            claudeUsage = event.usage;
          }
          if (event.modelUsage && typeof event.modelUsage === 'object') {
            claudeModelUsage = event.modelUsage;
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
            Object.assign(lastTool, applyToolTiming(lastTool, lastTool.startedAt || new Date().toISOString(), new Date().toISOString()));
            socket.emit('stream_tool_result', { sessionId: streamSession.id, result: lastTool.result, isError: tr.is_error, endedAt: lastTool.endedAt, durationMs: lastTool.durationMs });
          }
          return;
        }
        if (event.type !== 'stream_event' || !event.event) return;
        const evt = event.event;

        if (evt.type === 'content_block_start') {
          const block = evt.content_block;
          if (block.type === 'thinking') {
            thinking = '';
            thinkingStartedAt = new Date().toISOString();
            console.log('[STREAM] thinking_start');
            socket.emit('stream_thinking_start', { sessionId: streamSession.id, startedAt: thinkingStartedAt });
          } else if (block.type === 'tool_use') {
            toolInput = '';
            currentTool = { id: block.id, name: block.name, startedAt: new Date().toISOString() };
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
            const tool = applyToolTiming({ id: currentTool.id, name: currentTool.name, input }, currentTool.startedAt);
            socket.emit('stream_tool_use', { sessionId: streamSession.id, ...tool });
            assistantMsg.toolUses.push(tool);
            currentTool = null;
            toolInput = '';
          }
          if (thinking) {
            assistantMsg.thinking = thinking;
            const thinkingEndedAt = new Date().toISOString();
            assistantMsg.thinkingMeta = applyToolTiming({}, thinkingStartedAt || thinkingEndedAt, thinkingEndedAt);
            thinking = '';
            thinkingStartedAt = null;
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

      cli.on('close', async (code) => {
        if (processFailed) {
          return;
        }
        await Promise.allSettled(streamEventTasks);
        if (provider.id === 'codex') {
          finalizePendingToolTimings(assistantMsg.toolUses, new Date().toISOString());
          await enrichMissingFileChangeDiffs(assistantMsg.toolUses, streamSession.projectDir);
        } else {
          finalizePendingToolTimings(assistantMsg.toolUses, new Date().toISOString());
          await enrichClaudeFileDiffs(assistantMsg.toolUses, streamSession.projectDir);
        }
        // 优先用 result 事件的完整文本，否则用累积的 text_delta
        const fallbackError = [...codexErrors, filterCodexDiagnosticText(stderrText)].filter(Boolean).join('\n');
        assistantMsg.interrupted = interruptedProcesses.has(processKey);
        assistantMsg.content = resultText || fullResponse || fallbackError || `Assistant exited with code ${code}`;
        assistantMsg.durationMs = resultDurationMs ?? (Date.now() - requestStartedAt);
        if (provider.id === 'codex') {
          assistantMsg.contextUsage = buildContextUsagePayload(getCodexContextUsage(streamSession.cliSessionId));
        } else {
          assistantMsg.contextUsage = buildContextUsagePayload(getClaudeContextUsage(claudeUsage, claudeModelUsage));
          // 归档后用新 cliSessionId 创建会话，本次成功后置 ready，后续才能 resume
          streamSession.cliSessionReady = true;
        }
        streamSession.updatedAt = new Date().toISOString();
        saveSession(streamSession);
        socket.emit('stream_end', {
          sessionId: streamSession.id,
          code,
          content: assistantMsg.content,
          thinking: assistantMsg.thinking,
          thinkingMeta: assistantMsg.thinkingMeta,
          toolUses: assistantMsg.toolUses,
          durationMs: assistantMsg.durationMs,
          contextUsage: assistantMsg.contextUsage,
          interrupted: assistantMsg.interrupted,
          assistantName: assistantMsg.assistantName
        });
        activeProcesses.delete(processKey);
        interruptedProcesses.delete(processKey);
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
      interruptedProcesses.add(key);
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
      interruptedProcesses.delete(key);
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
