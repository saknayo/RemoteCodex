const API_BASE = '/api';
let token = localStorage.getItem('token');
let socket = null;
let currentSession = null;
let isStreaming = false;

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
const messageInput = document.getElementById('message-input');
const sendBtn = document.getElementById('send-btn');
const interruptBtn = document.getElementById('interrupt-btn');
const sessionTitle = document.getElementById('session-title');
const chatHeader = document.getElementById('chat-header');
const toggleSidebarBtn = document.getElementById('toggle-sidebar');

let isNavVisible = true;
let openSessionActionItem = null;

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

// 创建 assistant 气泡的骨架（thinking + toolUse + content 区域）
function createAssistantSkeleton() {
  const bubble = document.createElement('div');
  bubble.className = 'message-bubble assistant';

  const avatarCol = document.createElement('div');
  avatarCol.className = 'avatar-col';

  const avatar = document.createElement('div');
  avatar.className = 'message-avatar';
  avatar.textContent = 'AI';
  avatarCol.appendChild(avatar);

  const sender = document.createElement('div');
  sender.className = 'message-sender';
  sender.textContent = 'Claude';
  avatarCol.appendChild(sender);

  const time = document.createElement('div');
  time.className = 'message-time';
  time.textContent = new Date().toLocaleTimeString('zh-CN', {
    hour: '2-digit',
    minute: '2-digit'
  });
  avatarCol.appendChild(time);

  bubble.appendChild(avatarCol);

  const body = document.createElement('div');
  body.className = 'message-body';

  // thinking 区域（默认隐藏）
  thinkingEl = document.createElement('div');
  thinkingEl.className = 'thinking-block collapsed';
  thinkingEl.innerHTML = '<div class="thinking-header" onclick="this.parentElement.classList.toggle(\'collapsed\')">▶ 思考过程</div><div class="thinking-content"></div>';
  thinkingEl.style.display = 'none';
  body.appendChild(thinkingEl);

  // tool use 区域（默认隐藏）
  toolUseEl = document.createElement('div');
  toolUseEl.className = 'tool-use-area';
  toolUseEl.style.display = 'none';
  body.appendChild(toolUseEl);

  // 文本内容区域
  textContentEl = document.createElement('div');
  textContentEl.className = 'message-content';
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

  socket.on('connect_error', (error) => {
    console.error('Socket error:', error);
    if (error.message === 'Invalid token' || error.message === 'Missing token') {
      localStorage.removeItem('token');
      token = null;
      showLoginView();
    }
  });

  socket.on('session_loaded', (session) => {
    currentSession = session;
    renderSession();
    highlightSession(session.id);
  });

  socket.on('session_created', (session) => {
    currentSession = session;
    renderSession();
    loadSessions();
    highlightSession(session.id);
  });

  socket.on('message_added', (msg) => {
    if (!currentSession) return;
    currentSession.messages.push(msg);
    // user 消息正常渲染
    if (msg.role === 'user') {
      renderMessages();
    }
    // assistant 空消息：创建流式骨架
    if (msg.role === 'assistant' && isStreaming) {
      createAssistantSkeleton();
      hasThinking = false;
    }
  });

  socket.on('stream_thinking_start', () => {
    if (!thinkingEl) return;
    thinkingEl.style.display = 'block';
    thinkingEl.classList.remove('collapsed');
    hasThinking = true;
  });

  socket.on('stream_thinking', (chunk) => {
    if (!thinkingEl) return;
    const contentEl = thinkingEl.querySelector('.thinking-content');
    contentEl.textContent += chunk;
    scrollToBottom();
  });

  socket.on('stream_tool_use', (tool) => {
    if (!toolUseEl) return;
    toolUseEl.style.display = 'block';
    const item = createToolUseItem(tool);
    toolUseEl.appendChild(item);
    scrollToBottom();
  });

  socket.on('stream_tool_result', (data) => {
    if (!toolUseEl) return;
    const lastItem = toolUseEl.lastElementChild;
    if (!lastItem) return;
    const resultEl = document.createElement('pre');
    resultEl.className = 'tool-result-code';
    resultEl.textContent = data.result || '(no output)';
    if (data.isError) resultEl.classList.add('error');
    lastItem.appendChild(resultEl);
    scrollToBottom();
  });

  socket.on('stream_text', (text) => {
    if (!textContentEl) return;
    textContentEl.textContent += text;
    scrollToBottom();
  });

  socket.on('stream_end', (data) => {
    const content = data?.content || '';
    // 更新数据
    if (currentSession && currentSession.messages.length > 0) {
      const lastMsg = currentSession.messages[currentSession.messages.length - 1];
      if (lastMsg.role === 'assistant') {
        lastMsg.content = content;
        lastMsg.thinking = data.thinking || '';
        lastMsg.toolUses = data.toolUses || [];
      }
    }
    // 清理流式状态
    streamingBubble = null;
    thinkingEl = null;
    toolUseEl = null;
    textContentEl = null;
    isStreaming = false;
    sendBtn.textContent = 'Send';
    sendBtn.disabled = false;
    interruptBtn.style.display = 'none';
    // 最终渲染（Markdown + 保存的 thinking/tool 数据）
    renderMessages();
    loadSessions();
  });

  socket.on('stream_error', (error) => {
    // stderr 只是警告，不处理
  });
}

function showLoginView() {
  loginView.style.display = 'flex';
  mainView.style.display = 'none';
  if (socket) {
    socket.disconnect();
    socket = null;
  }
}

function showMainView() {
  loginView.style.display = 'none';
  mainView.style.display = 'flex';
  connectSocket();
  loadSessions();
}

function renderSession() {
  if (!currentSession) {
    sessionTitle.textContent = 'Select or create a session';
    messagesContainer.innerHTML = '';
    return;
  }

  sessionTitle.textContent = currentSession.title || 'Untitled';
  renderMessages();
}

function renderMessages() {
  if (!currentSession) return;

  messagesContainer.innerHTML = '';

  for (const msg of currentSession.messages) {
    const bubble = document.createElement('div');
    bubble.className = `message-bubble ${msg.role}`;

    const avatarCol = document.createElement('div');
    avatarCol.className = 'avatar-col';

    const avatar = document.createElement('div');
    avatar.className = 'message-avatar';
    avatar.textContent = msg.role === 'user' ? 'ME' : 'AI';
    avatarCol.appendChild(avatar);

    const sender = document.createElement('div');
    sender.className = 'message-sender';
    sender.textContent = msg.role === 'user' ? '你' : 'Claude';
    avatarCol.appendChild(sender);

    const time = document.createElement('div');
    time.className = 'message-time';
    time.textContent = new Date(msg.timestamp).toLocaleTimeString('zh-CN', {
      hour: '2-digit',
      minute: '2-digit'
    });
    avatarCol.appendChild(time);

    bubble.appendChild(avatarCol);

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

      bubble.appendChild(body);
    } else {
      const content = document.createElement('div');
      content.className = 'message-content';
      content.textContent = msg.content;
      bubble.appendChild(content);
    }

    messagesContainer.appendChild(bubble);
  }

  messagesContainer.scrollTop = messagesContainer.scrollHeight;
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

function renderSessionList(sessions) {
  sessionList.innerHTML = '';
  openSessionActionItem = null;

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

    const deleteBtn = document.createElement('button');
    deleteBtn.type = 'button';
    deleteBtn.className = 'session-delete-btn';
    deleteBtn.textContent = '删除';

    li.appendChild(deleteBtn);
    li.appendChild(content);

    let startX = 0;
    let startY = 0;
    let swipeStarted = false;
    let didSwipe = false;

    const closeItem = () => {
      li.classList.remove('show-delete');
      if (openSessionActionItem === li) {
        openSessionActionItem = null;
      }
    };

    const openItem = () => {
      if (openSessionActionItem && openSessionActionItem !== li) {
        openSessionActionItem.classList.remove('show-delete');
      }
      li.classList.add('show-delete');
      openSessionActionItem = li;
    };

    li.addEventListener('touchstart', (e) => {
      const touch = e.touches[0];
      startX = touch.clientX;
      startY = touch.clientY;
      swipeStarted = true;
      didSwipe = false;
    }, { passive: true });

    li.addEventListener('touchmove', (e) => {
      if (!swipeStarted) return;
      const touch = e.touches[0];
      const deltaX = touch.clientX - startX;
      const deltaY = touch.clientY - startY;
      if (Math.abs(deltaY) > Math.abs(deltaX)) return;
      if (deltaX < -30) {
        openItem();
        didSwipe = true;
      } else if (deltaX > 30) {
        closeItem();
        didSwipe = true;
      }
    }, { passive: true });

    li.addEventListener('touchend', () => {
      swipeStarted = false;
      setTimeout(() => {
        didSwipe = false;
      }, 250);
    });

    li.addEventListener('pointerdown', (e) => {
      if (e.pointerType === 'touch' || e.button !== 0) return;
      startX = e.clientX;
      startY = e.clientY;
      swipeStarted = true;
      didSwipe = false;
    });

    li.addEventListener('pointermove', (e) => {
      if (!swipeStarted || e.pointerType === 'touch') return;
      const deltaX = e.clientX - startX;
      const deltaY = e.clientY - startY;
      if (Math.abs(deltaY) > Math.abs(deltaX)) return;
      if (deltaX < -30) {
        openItem();
        didSwipe = true;
      } else if (deltaX > 30) {
        closeItem();
        didSwipe = true;
      }
    });

    li.addEventListener('pointerup', () => {
      swipeStarted = false;
      setTimeout(() => {
        didSwipe = false;
      }, 250);
    });

    li.addEventListener('pointerleave', () => {
      swipeStarted = false;
    });

    deleteBtn.addEventListener('click', async (e) => {
      e.stopPropagation();
      try {
        await apiFetch(`${API_BASE}/sessions/${session.id}`, { method: 'DELETE' });
        if (currentSession?.id === session.id) {
          currentSession = null;
          renderSession();
        }
        await loadSessions();
      } catch (error) {
        console.error('Failed to delete session:', error);
      }
    });

    li.addEventListener('click', () => {
      if (didSwipe) return;
      if (li.classList.contains('show-delete')) {
        closeItem();
        return;
      }
      if (openSessionActionItem) {
        openSessionActionItem.classList.remove('show-delete');
        openSessionActionItem = null;
      }
      if (socket && currentSession?.id !== session.id) {
        socket.emit('load_session', session.id);
      }
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
  if (socket) {
    socket.emit('new_session');
  }
});

chatHeader.addEventListener('click', () => {
  isNavVisible = !isNavVisible;
  mainView.classList.toggle('nav-collapsed', !isNavVisible);
  toggleSidebarBtn.setAttribute('aria-pressed', String(!isNavVisible));
  toggleSidebarBtn.textContent = isNavVisible ? '◀' : '▶';
});

sendBtn.addEventListener('click', () => {
  const content = messageInput.value.trim();
  if (!content || !socket || isStreaming) return;

  messageInput.value = '';
  messageInput.style.height = 'auto';

  isStreaming = true;
  sendBtn.textContent = 'Sending...';
  sendBtn.disabled = true;
  interruptBtn.style.display = 'inline-block';

  socket.emit('send_message', content);
});

interruptBtn.addEventListener('click', () => {
  if (socket) {
    socket.emit('interrupt');
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
