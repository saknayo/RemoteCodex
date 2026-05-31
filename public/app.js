const API_BASE = '/api';
let token = localStorage.getItem('token');
let socket = null;
let currentSession = null;
let pendingSessionId = null;
const streamingSessions = new Map();

// 流式渲染用的 DOM 引用
let streamingBubble = null;
let thinkingEl = null;
let toolUseEl = null;
let textContentEl = null;
let hasThinking = false;

const loginView = document.getElementById('login-view');
const mainView = document.getElementById('main-view');
const loginForm = document.getElementById('login-form');
const loginMessage = document.getElementById('login-message');
const loginBtn = document.getElementById('login-btn');

const sessionList = document.getElementById('session-list');
const messagesContainer = document.getElementById('messages');
const selectSessionBtn = document.getElementById('select-session-btn');
const messageInput = document.getElementById('message-input');
const sendBtn = document.getElementById('send-btn');
const interruptBtn = document.getElementById('interrupt-btn');
const sessionTitle = document.getElementById('session-title');
const chatHeader = document.getElementById('chat-header');
const toggleSidebarBtn = document.getElementById('toggle-sidebar');
const sessionsTab = document.getElementById('sessions-tab');
const conversationTab = document.getElementById('conversation-tab');
const newSessionModal = document.getElementById('new-session-modal');
const assistantSelect = document.getElementById('assistant-select');
const sessionNameInput = document.getElementById('session-name-input');
const projectDirInput = document.getElementById('project-dir-input');
const closeNewSessionModalBtn = document.getElementById('close-new-session-modal');
const cancelNewSessionBtn = document.getElementById('cancel-new-session-btn');
const createSessionBtn = document.getElementById('create-session-btn');
const sessionRenameModal = document.getElementById('session-rename-modal');
const sessionRenameInput = document.getElementById('session-rename-input');
const closeSessionRenameModalBtn = document.getElementById('close-session-rename-modal');
const cancelSessionRenameBtn = document.getElementById('cancel-session-rename-btn');
const saveSessionRenameBtn = document.getElementById('save-session-rename-btn');
const sessionDetailModal = document.getElementById('session-detail-modal');
const sessionDetailList = document.getElementById('session-detail-list');
const closeSessionDetailModalBtn = document.getElementById('close-session-detail-modal');

let isNavVisible = true;
let sessionContextMenu = null;
let sessionMenuCloseHandler = null;
let selectedSessionForAction = null;
let actionToastTimer = null;
let wakeLock = null;
let wakeLockRequested = false;
let wakeLockFallbackVideo = null;
let wakeLockFallbackStream = null;
let wakeLockFallbackInterval = null;

function getCurrentSessionId() {
  return currentSession?.id || null;
}

function getStreamingState(sessionId) {
  if (!sessionId) return null;
  return streamingSessions.get(sessionId) || null;
}

function ensureStreamingState(sessionId, assistantMsg = null) {
  if (!sessionId) return null;
  let state = streamingSessions.get(sessionId);
  if (!state) {
    state = {
      assistantMsg: assistantMsg || null,
      thinking: '',
      text: '',
      toolUses: [],
      hasThinking: false
    };
    streamingSessions.set(sessionId, state);
    syncWakeLock();
  } else if (assistantMsg) {
    state.assistantMsg = assistantMsg;
  }
  return state;
}

function isSessionStreaming(sessionId = getCurrentSessionId()) {
  return Boolean(sessionId && streamingSessions.has(sessionId));
}

function updateSendButton() {
  const streaming = isSessionStreaming();
  sendBtn.textContent = streaming ? 'Sending...' : 'Send';
  sendBtn.disabled = streaming;
  interruptBtn.style.display = streaming ? 'inline-block' : 'none';
}

async function requestWakeLock() {
  if (wakeLock || wakeLockRequested) return;
  if (!('wakeLock' in navigator)) {
    enableWakeLockFallback();
    return;
  }
  wakeLockRequested = true;
  try {
    wakeLock = await navigator.wakeLock.request('screen');
    wakeLock.addEventListener('release', () => {
      wakeLock = null;
    });
  } catch (error) {
    console.warn('Wake Lock request failed:', error);
    enableWakeLockFallback();
  } finally {
    wakeLockRequested = false;
  }
}

async function releaseWakeLock() {
  const lock = wakeLock;
  wakeLock = null;
  if (lock) {
    try {
      await lock.release();
    } catch (error) {
      console.warn('Wake Lock release failed:', error);
    }
  }
  disableWakeLockFallback();
}

function syncWakeLock() {
  if (streamingSessions.size > 0) {
    requestWakeLock();
  } else {
    releaseWakeLock();
  }
}

function enableWakeLockFallback() {
  if (wakeLockFallbackVideo) return;
  const canvas = document.createElement('canvas');
  canvas.width = 2;
  canvas.height = 2;
  const context = canvas.getContext('2d');
  if (!context || typeof canvas.captureStream !== 'function') {
    console.warn('Wake Lock fallback is not supported by this browser.');
    return;
  }

  let tick = 0;
  const drawFrame = () => {
    context.fillStyle = tick % 2 === 0 ? '#000' : '#111';
    context.fillRect(0, 0, 2, 2);
    tick++;
  };
  drawFrame();
  wakeLockFallbackInterval = setInterval(drawFrame, 1000);
  wakeLockFallbackStream = canvas.captureStream(1);
  wakeLockFallbackStream.addEventListener?.('inactive', () => {
    if (wakeLockFallbackInterval) {
      clearInterval(wakeLockFallbackInterval);
      wakeLockFallbackInterval = null;
    }
  });

  const video = document.createElement('video');
  video.muted = true;
  video.playsInline = true;
  video.setAttribute('muted', '');
  video.setAttribute('playsinline', '');
  video.style.position = 'fixed';
  video.style.width = '1px';
  video.style.height = '1px';
  video.style.opacity = '0.01';
  video.style.pointerEvents = 'none';
  video.style.left = '0';
  video.style.bottom = '0';
  video.srcObject = wakeLockFallbackStream;
  document.body.appendChild(video);
  wakeLockFallbackVideo = video;

  video.play().catch((error) => {
    console.warn('Wake Lock fallback playback failed:', error);
    disableWakeLockFallback();
  });
}

function disableWakeLockFallback() {
  if (wakeLockFallbackVideo) {
    wakeLockFallbackVideo.pause();
    wakeLockFallbackVideo.remove();
    wakeLockFallbackVideo = null;
  }
  if (wakeLockFallbackStream) {
    for (const track of wakeLockFallbackStream.getTracks()) {
      track.stop();
    }
    wakeLockFallbackStream = null;
  }
  if (wakeLockFallbackInterval) {
    clearInterval(wakeLockFallbackInterval);
    wakeLockFallbackInterval = null;
  }
}

function clearStreamingDomRefs() {
  streamingBubble = null;
  thinkingEl = null;
  toolUseEl = null;
  textContentEl = null;
  hasThinking = false;
}

function setMainTab(tab) {
  const showSessions = tab === 'sessions';
  mainView.classList.toggle('show-sessions', showSessions);
  mainView.classList.toggle('show-conversation', !showSessions);
  sessionsTab.classList.toggle('active', showSessions);
  conversationTab.classList.toggle('active', !showSessions);
}

function createMessageMeta(senderLabel, timestamp = new Date(), options = {}) {
  const meta = document.createElement('div');
  meta.className = 'message-meta';

  const sender = document.createElement('span');
  sender.className = 'message-sender';
  sender.textContent = senderLabel === 'user' ? '你' : senderLabel;

  const time = document.createElement('span');
  time.className = 'message-time';
  time.textContent = new Date(timestamp).toLocaleTimeString('zh-CN', {
    hour: '2-digit',
    minute: '2-digit'
  });

  meta.appendChild(sender);
  meta.appendChild(time);

  if (options.loading) {
    const spinner = document.createElement('span');
    spinner.className = 'message-meta-spinner';
    spinner.setAttribute('aria-label', '正在思考');
    meta.appendChild(spinner);
  }

  return meta;
}

function getAssistantName(msg = currentSession) {
  return msg?.assistantName || currentSession?.assistantName || 'Claude';
}

function formatDuration(durationMs) {
  if (typeof durationMs !== 'number' || !Number.isFinite(durationMs) || durationMs < 0) {
    return '';
  }
  if (durationMs < 1000) {
    return `${Math.round(durationMs)}ms`;
  }
  return `${(durationMs / 1000).toFixed(1)}s`;
}

function createDurationEl(durationMs) {
  const durationText = formatDuration(durationMs);
  if (!durationText) return null;
  const duration = document.createElement('div');
  duration.className = 'message-duration';
  duration.textContent = `耗时 ${durationText}`;
  return duration;
}

function openNewSessionModal() {
  newSessionModal.style.display = 'flex';
  sessionNameInput.focus();
  sessionNameInput.select();
}

function closeNewSessionModal() {
  newSessionModal.style.display = 'none';
}

function showActionToast(message, type = 'info') {
  let toast = document.getElementById('action-toast');
  if (!toast) {
    toast = document.createElement('div');
    toast.id = 'action-toast';
    document.body.appendChild(toast);
  }

  toast.className = `action-toast ${type}`;
  toast.textContent = message;
  toast.style.display = 'block';

  if (actionToastTimer) {
    clearTimeout(actionToastTimer);
  }
  actionToastTimer = setTimeout(() => {
    toast.style.display = 'none';
  }, 2200);
}

function openSessionRenameModal(session) {
  selectedSessionForAction = session;
  sessionRenameInput.value = session.title || 'Untitled';
  sessionRenameModal.style.display = 'flex';
  sessionRenameInput.focus();
  sessionRenameInput.select();
}

function closeSessionRenameModal() {
  sessionRenameModal.style.display = 'none';
  selectedSessionForAction = null;
}

async function saveSessionRename() {
  if (!selectedSessionForAction) return;
  const title = sessionRenameInput.value.trim();
  if (!title) {
    sessionRenameInput.focus();
    return;
  }

  try {
    const session = await apiFetch(`${API_BASE}/sessions/${selectedSessionForAction.id}/title`, {
      method: 'PUT',
      body: JSON.stringify({ title })
    });
    if (currentSession?.id === session.id) {
      currentSession = session;
      renderSession();
    }
    closeSessionRenameModal();
    await loadSessions();
    showActionToast('Session renamed', 'success');
  } catch (error) {
    console.error('Failed to rename session:', error);
    showActionToast('Rename failed', 'error');
  }
}

function addSessionDetailRow(label, value) {
  const term = document.createElement('dt');
  term.textContent = label;
  const desc = document.createElement('dd');
  desc.textContent = value || '-';
  sessionDetailList.appendChild(term);
  sessionDetailList.appendChild(desc);
}

function formatDetailDate(value) {
  if (!value) return '-';
  return new Date(value).toLocaleString('zh-CN');
}

async function openSessionDetailModal(session) {
  try {
    const detail = await apiFetch(`${API_BASE}/sessions/${session.id}`);
    sessionDetailList.innerHTML = '';
    addSessionDetailRow('Name', detail.title || 'Untitled');
    addSessionDetailRow('Assistant', detail.assistantName || detail.provider || 'Claude');
    addSessionDetailRow('Provider', detail.provider || 'claude');
    addSessionDetailRow('Project Directory', detail.projectDir || '');
    addSessionDetailRow('Messages', String(detail.messages?.length || 0));
    addSessionDetailRow('Created', formatDetailDate(detail.createdAt));
    addSessionDetailRow('Updated', formatDetailDate(detail.updatedAt));
    sessionDetailModal.style.display = 'flex';
  } catch (error) {
    console.error('Failed to load session details:', error);
    showActionToast('Details unavailable', 'error');
  }
}

function closeSessionDetailModal() {
  sessionDetailModal.style.display = 'none';
  sessionDetailList.innerHTML = '';
}

async function copySessionConfig(session) {
  try {
    const copied = await apiFetch(`${API_BASE}/sessions/${session.id}/copy`, {
      method: 'POST'
    });
    await loadSessions();
    if (socket) {
      socket.emit('load_session', copied.id);
    }
    showActionToast('Session copied', 'success');
  } catch (error) {
    console.error('Failed to copy session:', error);
    showActionToast('Copy failed', 'error');
  }
}

async function deleteSession(session) {
  try {
    await apiFetch(`${API_BASE}/sessions/${session.id}`, { method: 'DELETE' });
    if (currentSession?.id === session.id) {
      currentSession = null;
      renderSession();
    }
    await loadSessions();
    showActionToast('Session deleted', 'success');
  } catch (error) {
    console.error('Failed to delete session:', error);
    showActionToast('Delete failed', 'error');
  }
}

function createSessionFromModal() {
  if (!socket) return;
  socket.emit('new_session', {
    provider: assistantSelect.value,
    title: sessionNameInput.value.trim(),
    projectDir: projectDirInput.value.trim()
  });
  closeNewSessionModal();
}

function showMessage(message, type = 'info') {
  loginMessage.textContent = message;
  loginMessage.className = `message ${type}`;
  setTimeout(() => {
    loginMessage.className = 'message';
  }, 5000);
}

function apiFetch(url, options = {}) {
  const headers = {
    'Content-Type': 'application/json',
    ...options.headers
  };

  if (token) {
    headers['Authorization'] = `Bearer ${token}`;
  }

  return fetch(url, {
    ...options,
    headers
  }).then(async (res) => {
    if (res.status === 401) {
      localStorage.removeItem('token');
      token = null;
      showLoginView();
      throw new Error('Unauthorized');
    }
    return res.json().then(data => {
      if (!res.ok) {
        throw new Error(data.error || data.message || 'Request failed');
      }
      return data;
    });
  });
}

function scrollToBottom() {
  messagesContainer.scrollTop = messagesContainer.scrollHeight;
}

function isNearMessageBottom() {
  const distance = messagesContainer.scrollHeight - messagesContainer.scrollTop - messagesContainer.clientHeight;
  return distance < 80;
}

function scrollToBottomIfNear(wasNearBottom) {
  if (wasNearBottom) {
    scrollToBottom();
  }
}

// 创建 assistant 气泡的骨架（thinking + toolUse + content 区域）
function createAssistantSkeleton(msg = null, state = null) {
  const bubble = document.createElement('div');
  bubble.className = 'message-bubble assistant';

  bubble.appendChild(createMessageMeta(getAssistantName(msg), msg?.timestamp, { loading: true }));

  const body = document.createElement('div');
  body.className = 'message-body';

  // thinking 区域（默认隐藏）
  thinkingEl = document.createElement('div');
  thinkingEl.className = 'thinking-block collapsed';
  thinkingEl.innerHTML = '<div class="thinking-header" onclick="this.parentElement.classList.toggle(\'collapsed\')">▶ 思考过程</div><div class="thinking-content"></div>';
  thinkingEl.style.display = state?.thinking ? 'block' : 'none';
  if (state?.thinking) {
    thinkingEl.querySelector('.thinking-content').textContent = state.thinking;
  }
  body.appendChild(thinkingEl);

  // tool use 区域（默认隐藏）
  toolUseEl = document.createElement('div');
  toolUseEl.className = 'tool-use-area';
  toolUseEl.style.display = state?.toolUses?.length ? 'block' : 'none';
  for (const tool of state?.toolUses || []) {
    toolUseEl.appendChild(createToolUseItem(tool));
  }
  body.appendChild(toolUseEl);

  // 文本内容区域
  textContentEl = document.createElement('div');
  textContentEl.className = 'message-content';
  textContentEl.style.display = state?.text ? 'block' : 'none';
  textContentEl.textContent = state?.text || '';
  body.appendChild(textContentEl);

  bubble.appendChild(body);
  messagesContainer.appendChild(bubble);
  streamingBubble = bubble;
}

function createToolUseItem(tool) {
  const item = document.createElement('div');
  item.className = 'tool-use-item collapsed';

  const header = document.createElement('div');
  header.className = 'tool-use-header';
  const icon = tool.name === 'Bash' ? '⚡' : '🔧';
  header.textContent = `${icon} ${tool.name}`;
  header.addEventListener('click', () => {
    item.classList.toggle('collapsed');
  });
  item.appendChild(header);

  if (tool.name === 'Bash' && tool.input.command) {
    const code = document.createElement('pre');
    code.className = 'tool-use-code';
    code.textContent = tool.input.command;
    item.appendChild(code);
  } else if (tool.input.file_path) {
    const path = document.createElement('div');
    path.className = 'tool-use-path';
    path.textContent = tool.input.file_path;
    item.appendChild(path);
  } else {
    const desc = document.createElement('div');
    desc.className = 'tool-use-path';
    desc.textContent = JSON.stringify(tool.input).substring(0, 200);
    item.appendChild(desc);
  }

  if (tool.result) {
    const resultEl = document.createElement('pre');
    resultEl.className = 'tool-result-code';
    resultEl.textContent = tool.result;
    item.appendChild(resultEl);
  }

  return item;
}

function connectSocket() {
  if (socket) {
    socket.disconnect();
  }

  socket = io({
    auth: { token }
  });

  socket.on('connect', () => {
    const sessionIdToLoad = pendingSessionId || currentSession?.id;
    if (sessionIdToLoad) {
      socket.emit('load_session', sessionIdToLoad);
    }
  });

  function isCurrentStreamSession(sessionId) {
    return Boolean(sessionId && currentSession?.id === sessionId);
  }

  function resetStreamingState(sessionId = getCurrentSessionId(), message = null) {
    if (!sessionId) return;
    if (message && isCurrentStreamSession(sessionId) && textContentEl) {
      textContentEl.style.display = 'block';
      textContentEl.textContent = message;
    }
    streamingSessions.delete(sessionId);
    syncWakeLock();
    if (isCurrentStreamSession(sessionId)) {
      clearStreamingDomRefs();
      updateSendButton();
    }
    if (message && isCurrentStreamSession(sessionId)) {
      renderMessages();
    }
  }

  socket.on('connect_error', (error) => {
    console.error('Socket error:', error);
    if (currentSession?.id && isSessionStreaming(currentSession.id)) {
      resetStreamingState(currentSession.id, error.message || 'Connection failed.');
    }
    if (error.message === 'Invalid token' || error.message === 'Missing token') {
      localStorage.removeItem('token');
      token = null;
      showLoginView();
    }
  });

  socket.on('disconnect', () => {
    if (currentSession?.id && isSessionStreaming(currentSession.id)) {
      resetStreamingState(currentSession.id, 'Connection lost. Please resend your message.');
    }
    streamingSessions.clear();
    syncWakeLock();
    updateSendButton();
  });

  socket.on('session_loaded', (session) => {
    pendingSessionId = null;
    if (session.isStreaming && !streamingSessions.has(session.id)) {
      ensureStreamingState(session.id);
    }
    currentSession = session;
    renderSession();
    highlightSession(session.id);
    setMainTab('conversation');
    updateSendButton();
  });

  socket.on('session_created', (session) => {
    pendingSessionId = null;
    currentSession = session;
    renderSession();
    loadSessions();
    highlightSession(session.id);
    setMainTab('conversation');
    updateSendButton();
  });

  socket.on('session_error', (message) => {
    console.error('Session error:', message);
    pendingSessionId = null;
    sessionTitle.textContent = message || 'Failed to create session';
  });

  socket.on('message_added', (msg) => {
    const sessionId = msg?.sessionId || currentSession?.id;
    const message = msg?.message || msg;
    if (!sessionId || !message) return;
    if (message.role === 'assistant' && isSessionStreaming(sessionId)) {
      ensureStreamingState(sessionId, message);
    }
    if (!isCurrentStreamSession(sessionId)) return;
    if (!currentSession) return;
    currentSession.messages.push(message);
    // user 消息正常渲染
    if (message.role === 'user') {
      renderMessages();
    }
    // assistant 空消息：创建流式骨架
    if (message.role === 'assistant' && isSessionStreaming(sessionId)) {
      createAssistantSkeleton(message, getStreamingState(sessionId));
      hasThinking = false;
    }
  });

  socket.on('stream_thinking_start', (data = {}) => {
    const sessionId = data.sessionId || currentSession?.id;
    const state = ensureStreamingState(sessionId);
    if (state) state.hasThinking = true;
    if (!isCurrentStreamSession(sessionId) || !thinkingEl) return;
    thinkingEl.style.display = 'block';
    thinkingEl.classList.remove('collapsed');
    hasThinking = true;
  });

  socket.on('stream_thinking', (data) => {
    const sessionId = data?.sessionId || currentSession?.id;
    const chunk = typeof data === 'string' ? data : data?.chunk;
    if (!chunk) return;
    const state = ensureStreamingState(sessionId);
    if (state) state.thinking += chunk;
    if (!isCurrentStreamSession(sessionId) || !thinkingEl) return;
    const wasNearBottom = isNearMessageBottom();
    const contentEl = thinkingEl.querySelector('.thinking-content');
    contentEl.textContent += chunk;
    scrollToBottomIfNear(wasNearBottom);
  });

  socket.on('stream_tool_use', (tool) => {
    const sessionId = tool?.sessionId || currentSession?.id;
    const cleanTool = { ...tool };
    delete cleanTool.sessionId;
    const state = ensureStreamingState(sessionId);
    if (state) state.toolUses.push(cleanTool);
    if (!isCurrentStreamSession(sessionId) || !toolUseEl) return;
    const wasNearBottom = isNearMessageBottom();
    toolUseEl.style.display = 'block';
    const item = createToolUseItem(cleanTool);
    toolUseEl.appendChild(item);
    scrollToBottomIfNear(wasNearBottom);
  });

  socket.on('stream_tool_result', (data) => {
    const sessionId = data?.sessionId || currentSession?.id;
    const state = getStreamingState(sessionId);
    if (state?.toolUses?.length) {
      const lastTool = state.toolUses[state.toolUses.length - 1];
      lastTool.result = data.result || '(no output)';
      lastTool.isError = data.isError;
    }
    if (!isCurrentStreamSession(sessionId) || !toolUseEl) return;
    const lastItem = toolUseEl.lastElementChild;
    if (!lastItem) return;
    const resultEl = document.createElement('pre');
    resultEl.className = 'tool-result-code';
    resultEl.textContent = data.result || '(no output)';
    if (data.isError) resultEl.classList.add('error');
    const wasNearBottom = isNearMessageBottom();
    lastItem.appendChild(resultEl);
    scrollToBottomIfNear(wasNearBottom);
  });

  socket.on('stream_text', (data) => {
    const sessionId = data?.sessionId || currentSession?.id;
    const text = typeof data === 'string' ? data : data?.text;
    if (!text) return;
    const state = ensureStreamingState(sessionId);
    if (state) state.text += text;
    if (!isCurrentStreamSession(sessionId) || !textContentEl) return;
    const wasNearBottom = isNearMessageBottom();
    textContentEl.style.display = 'block';
    textContentEl.textContent += text;
    scrollToBottomIfNear(wasNearBottom);
  });

  socket.on('stream_end', (data) => {
    const sessionId = data?.sessionId || currentSession?.id;
    const content = data?.content || '';
    const wasNearBottom = isCurrentStreamSession(sessionId) ? isNearMessageBottom() : false;
    // 更新数据
    if (isCurrentStreamSession(sessionId) && currentSession && currentSession.messages.length > 0) {
      const lastMsg = currentSession.messages[currentSession.messages.length - 1];
      if (lastMsg.role === 'assistant') {
        lastMsg.content = content;
        lastMsg.thinking = data.thinking || '';
        lastMsg.toolUses = data.toolUses || [];
        lastMsg.durationMs = data.durationMs ?? null;
        lastMsg.assistantName = data.assistantName || lastMsg.assistantName || currentSession.assistantName || 'Claude';
      }
    }
    // 清理流式状态
    resetStreamingState(sessionId);
    // 最终渲染（Markdown + 保存的 thinking/tool 数据）
    if (isCurrentStreamSession(sessionId)) {
      renderMessages({ scrollToBottom: wasNearBottom });
    }
    loadSessions();
  });

  socket.on('stream_error', (error) => {
    const sessionId = error?.sessionId || currentSession?.id;
    const message = (typeof error === 'string' ? error : error?.message) || 'Assistant failed to respond.';
    const wasNearBottom = isCurrentStreamSession(sessionId) ? isNearMessageBottom() : false;
    if (isCurrentStreamSession(sessionId) && textContentEl) {
      textContentEl.style.display = 'block';
      textContentEl.textContent = message;
    }
    if (isCurrentStreamSession(sessionId) && currentSession && currentSession.messages.length > 0) {
      const lastMsg = currentSession.messages[currentSession.messages.length - 1];
      if (lastMsg.role === 'assistant') {
        lastMsg.content = message;
      }
    }
    resetStreamingState(sessionId);
    if (isCurrentStreamSession(sessionId)) {
      renderMessages({ scrollToBottom: wasNearBottom });
    }
  });
}

function showLoginView() {
  loginView.style.display = 'flex';
  mainView.style.display = 'none';
  pendingSessionId = null;
  streamingSessions.clear();
  syncWakeLock();
  if (socket) {
    socket.disconnect();
    socket = null;
  }
}

function showMainView() {
  loginView.style.display = 'none';
  mainView.style.display = 'flex';
  setMainTab('conversation');
  connectSocket();
  loadSessions();
  updateSendButton();
}

function renderSession() {
  if (!currentSession) {
    mainView.classList.add('no-session');
    sessionTitle.textContent = 'Select or create a session';
    sessionTitle.removeAttribute('title');
    messagesContainer.innerHTML = '';
    const emptyState = document.createElement('div');
    emptyState.id = 'conversation-empty-state';
    emptyState.className = 'conversation-empty-state';
    const selectButton = document.createElement('button');
    selectButton.id = 'select-session-btn';
    selectButton.type = 'button';
    selectButton.textContent = 'Select Session';
    selectButton.addEventListener('click', () => setMainTab('sessions'));
    emptyState.appendChild(selectButton);
    messagesContainer.appendChild(emptyState);
    updateSendButton();
    return;
  }

  mainView.classList.remove('no-session');
  sessionTitle.textContent = currentSession.title || 'Untitled';
  sessionTitle.title = `${currentSession.assistantName || 'Claude'} · ${currentSession.projectDir || ''}`;
  renderMessages();
  updateSendButton();
}

function showSessionLoading(session) {
  mainView.classList.remove('no-session');
  currentSession = {
    id: session.id,
    title: session.title || 'Untitled',
    assistantName: session.assistantName || 'Claude',
    projectDir: session.projectDir || '',
    messages: []
  };
  sessionTitle.textContent = currentSession.title;
  sessionTitle.title = `${currentSession.assistantName} · ${currentSession.projectDir}`;
  messagesContainer.innerHTML = '';
  clearStreamingDomRefs();
  const loading = document.createElement('div');
  loading.className = 'session-loading-state';
  loading.textContent = 'Loading session...';
  messagesContainer.appendChild(loading);
  updateSendButton();
}

function renderMessages(options = {}) {
  if (!currentSession) return;
  const shouldScrollToBottom = options.scrollToBottom !== false;

  messagesContainer.innerHTML = '';
  clearStreamingDomRefs();
  const streamingState = getStreamingState(currentSession.id);

  for (let index = 0; index < currentSession.messages.length; index++) {
    const msg = currentSession.messages[index];
    const isStreamingPlaceholder = Boolean(
      streamingState &&
      msg.role === 'assistant' &&
      !msg.content &&
      index === currentSession.messages.length - 1
    );
    if (isStreamingPlaceholder) {
      continue;
    }
    const bubble = document.createElement('div');
    bubble.className = `message-bubble ${msg.role}`;

    bubble.appendChild(createMessageMeta(msg.role === 'user' ? 'user' : getAssistantName(msg), msg.timestamp));

    if (msg.role === 'assistant') {
      const body = document.createElement('div');
      body.className = 'message-body';

      // thinking
      if (msg.thinking) {
        const thinkBlock = document.createElement('div');
        thinkBlock.className = 'thinking-block collapsed';
        thinkBlock.innerHTML = `<div class="thinking-header" onclick="this.parentElement.classList.toggle('collapsed')">▶ 思考过程</div><div class="thinking-content">${escapeHtml(msg.thinking)}</div>`;
        body.appendChild(thinkBlock);
      }

      // tool uses
      if (msg.toolUses && msg.toolUses.length > 0) {
        const toolArea = document.createElement('div');
        toolArea.className = 'tool-use-area';
        for (const tool of msg.toolUses) {
          const item = createToolUseItem(tool);
          toolArea.appendChild(item);
        }
        body.appendChild(toolArea);
      }

      // content
      const content = document.createElement('div');
      content.className = 'message-content';
      content.innerHTML = marked.parse(msg.content || '');
      body.appendChild(content);

      const duration = createDurationEl(msg.durationMs);
      if (duration) {
        body.appendChild(duration);
      }

      bubble.appendChild(body);
    } else {
      const content = document.createElement('div');
      content.className = 'message-content';
      content.textContent = msg.content;
      bubble.appendChild(content);
    }

    messagesContainer.appendChild(bubble);
  }

  if (streamingState?.assistantMsg) {
    createAssistantSkeleton(streamingState.assistantMsg, streamingState);
  }

  if (shouldScrollToBottom) {
    messagesContainer.scrollTop = messagesContainer.scrollHeight;
  }
}

function escapeHtml(text) {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

async function loadSessions() {
  try {
    const sessions = await apiFetch(`${API_BASE}/sessions`);
    renderSessionList(sessions);
  } catch (error) {
    console.error('Failed to load sessions:', error);
  }
}

function closeSessionContextMenu() {
  if (sessionContextMenu) {
    sessionContextMenu.remove();
    sessionContextMenu = null;
  }
  if (sessionMenuCloseHandler) {
    document.removeEventListener('pointerdown', sessionMenuCloseHandler, true);
    document.removeEventListener('keydown', sessionMenuCloseHandler, true);
    window.removeEventListener('resize', sessionMenuCloseHandler);
    sessionMenuCloseHandler = null;
  }
}

function createSessionMenuButton(label, action, options = {}) {
  const button = document.createElement('button');
  button.type = 'button';
  button.textContent = label;
  if (options.danger) {
    button.classList.add('danger');
  }
  button.addEventListener('click', async (e) => {
    e.stopPropagation();
    closeSessionContextMenu();
    await action();
  });
  return button;
}

function openSessionContextMenu(session, x, y) {
  closeSessionContextMenu();
  closeSessionDetailModal();

  sessionContextMenu = document.createElement('div');
  sessionContextMenu.className = 'session-context-menu';
  sessionContextMenu.appendChild(createSessionMenuButton('Rename', () => openSessionRenameModal(session)));
  sessionContextMenu.appendChild(createSessionMenuButton('Details', () => openSessionDetailModal(session)));
  sessionContextMenu.appendChild(createSessionMenuButton('Copy Session', () => copySessionConfig(session)));
  sessionContextMenu.appendChild(createSessionMenuButton('Delete', () => deleteSession(session), { danger: true }));
  document.body.appendChild(sessionContextMenu);

  const menuRect = sessionContextMenu.getBoundingClientRect();
  const left = Math.min(Math.max(x, 8), window.innerWidth - menuRect.width - 8);
  const top = Math.min(Math.max(y, 8), window.innerHeight - menuRect.height - 8);
  sessionContextMenu.style.left = `${left}px`;
  sessionContextMenu.style.top = `${top}px`;

  sessionMenuCloseHandler = (event) => {
    if (event.type === 'keydown' && event.key !== 'Escape') return;
    if (event.type === 'pointerdown' && sessionContextMenu?.contains(event.target)) return;
    closeSessionContextMenu();
  };
  setTimeout(() => {
    document.addEventListener('pointerdown', sessionMenuCloseHandler, true);
    document.addEventListener('keydown', sessionMenuCloseHandler, true);
    window.addEventListener('resize', sessionMenuCloseHandler);
  }, 0);
}

function renderSessionList(sessions) {
  sessionList.innerHTML = '';

  for (const session of sessions) {
    const li = document.createElement('li');
    li.className = 'session-item';
    li.dataset.id = session.id;

    const content = document.createElement('div');
    content.className = 'session-item-content';

    const date = document.createElement('span');
    date.className = 'session-item-date';
    date.textContent = new Date(session.updatedAt).toLocaleString('zh-CN', {
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit'
    });

    const separator = document.createElement('span');
    separator.className = 'session-item-separator';
    separator.textContent = '|';

    const title = document.createElement('span');
    title.className = 'session-item-title';
    title.textContent = session.title || 'Untitled';

    content.appendChild(date);
    content.appendChild(separator);
    content.appendChild(title);

    const menuBtn = document.createElement('button');
    menuBtn.type = 'button';
    menuBtn.className = 'session-menu-btn';
    menuBtn.setAttribute('aria-label', 'Session actions');
    const menuDot = document.createElement('span');
    menuDot.className = 'session-menu-dot';
    menuBtn.appendChild(menuDot);

    li.appendChild(content);
    li.appendChild(menuBtn);

    menuBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      const rect = menuBtn.getBoundingClientRect();
      openSessionContextMenu(session, rect.left, rect.bottom + 4);
    });

    li.addEventListener('click', () => {
      closeSessionContextMenu();
      highlightSession(session.id);
      setMainTab('conversation');
      if (currentSession?.id === session.id) {
        mainView.classList.remove('no-session');
        renderSession();
        updateSendButton();
        return;
      }
      pendingSessionId = session.id;
      showSessionLoading(session);
      if (socket) {
        socket.emit('load_session', session.id);
      }
      updateSendButton();
    });

    sessionList.appendChild(li);
  }
}

function highlightSession(id) {
  document.querySelectorAll('.session-item').forEach(item => {
    item.classList.toggle('active', item.dataset.id === id);
  });
}

loginForm.addEventListener('submit', async (e) => {
  e.preventDefault();

  const username = document.getElementById('username').value;
  const password = document.getElementById('password').value;

  loginBtn.disabled = true;
  loginBtn.textContent = 'Login...';

  try {
    const response = await apiFetch(`${API_BASE}/auth/login`, {
      method: 'POST',
      body: JSON.stringify({ username, password })
    });

    token = response.token;
    localStorage.setItem('token', token);
    showMainView();
  } catch (error) {
    const errorData = error.message || error;

    if (errorData.includes('IP_blocked') || errorData.includes('too_soon') || errorData.includes('rate_limit')) {
      showMessage(errorData, 'error');

      if (errorData.includes('wait') || errorData.includes('blocked')) {
        startCountdown();
      }
    } else if (errorData.includes('剩余尝试次数')) {
      showMessage(errorData, 'error');
    } else {
      showMessage('Login failed. Please check your credentials.', 'error');
    }
  } finally {
    loginBtn.disabled = false;
    loginBtn.textContent = 'Login';
  }
});

let countdownInterval = null;

function startCountdown() {
  apiFetch(`${API_BASE}/auth/status`).then(status => {
    if (status.waitSeconds > 0) {
      loginBtn.disabled = true;
      let remaining = status.waitSeconds;

      showMessage(status.isBlocked ? `IP被封禁，请等待 ${remaining} 秒` : `请等待 ${remaining} 秒后再次尝试`, 'info');

      countdownInterval = setInterval(() => {
        remaining--;
        if (remaining <= 0) {
          clearInterval(countdownInterval);
          loginBtn.disabled = false;
          loginMessage.className = 'message';
        } else {
          showMessage(status.isBlocked ? `IP被封禁，请等待 ${remaining} 秒` : `请等待 ${remaining} 秒后再次尝试`, 'info');
        }
      }, 1000);
    }
  });
}

document.getElementById('logout-btn').addEventListener('click', () => {
  localStorage.removeItem('token');
  token = null;
  showLoginView();
});

document.getElementById('new-session-btn').addEventListener('click', () => {
  openNewSessionModal();
});

sessionsTab.addEventListener('click', () => {
  setMainTab('sessions');
});

conversationTab.addEventListener('click', () => {
  setMainTab('conversation');
});

selectSessionBtn.addEventListener('click', () => {
  setMainTab('sessions');
});

closeNewSessionModalBtn.addEventListener('click', closeNewSessionModal);
cancelNewSessionBtn.addEventListener('click', closeNewSessionModal);
createSessionBtn.addEventListener('click', createSessionFromModal);

newSessionModal.addEventListener('click', (e) => {
  if (e.target === newSessionModal) {
    closeNewSessionModal();
  }
});

closeSessionRenameModalBtn.addEventListener('click', closeSessionRenameModal);
cancelSessionRenameBtn.addEventListener('click', closeSessionRenameModal);
saveSessionRenameBtn.addEventListener('click', saveSessionRename);

sessionRenameModal.addEventListener('click', (e) => {
  if (e.target === sessionRenameModal) {
    closeSessionRenameModal();
  }
});

sessionRenameInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') {
    saveSessionRename();
  }
});

closeSessionDetailModalBtn.addEventListener('click', closeSessionDetailModal);

sessionDetailModal.addEventListener('click', (e) => {
  if (e.target === sessionDetailModal) {
    closeSessionDetailModal();
  }
});

projectDirInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') {
    createSessionFromModal();
  }
});

sessionNameInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') {
    createSessionFromModal();
  }
});

document.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape') return;
  if (newSessionModal.style.display !== 'none') {
    closeNewSessionModal();
  }
  if (sessionRenameModal.style.display !== 'none') {
    closeSessionRenameModal();
  }
  if (sessionDetailModal.style.display !== 'none') {
    closeSessionDetailModal();
  }
  closeSessionContextMenu();
});

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') {
    syncWakeLock();
  }
});

chatHeader.addEventListener('click', () => {
  isNavVisible = !isNavVisible;
  mainView.classList.toggle('nav-collapsed', !isNavVisible);
  toggleSidebarBtn.setAttribute('aria-pressed', String(!isNavVisible));
  toggleSidebarBtn.textContent = isNavVisible ? '⛶' : '↙';
});

sendBtn.addEventListener('click', () => {
  const content = messageInput.value.trim();
  const sessionId = currentSession?.id;
  if (!content || !sessionId || isSessionStreaming(sessionId)) return;
  if (!socket || !socket.connected) {
    renderSession();
    return;
  }

  messageInput.value = '';
  messageInput.style.height = 'auto';

  ensureStreamingState(sessionId);
  updateSendButton();

  socket.emit('send_message', {
    sessionId,
    content
  });
});

interruptBtn.addEventListener('click', () => {
  if (socket) {
    socket.emit('interrupt', { sessionId: currentSession?.id });
  }
});

messageInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    sendBtn.click();
  }
});

messageInput.addEventListener('input', () => {
  messageInput.style.height = 'auto';
  messageInput.style.height = messageInput.scrollHeight + 'px';
});

if (token) {
  showMainView();
} else {
  showLoginView();
}
