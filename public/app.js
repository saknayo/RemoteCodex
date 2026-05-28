const API_BASE = '/api';
let token = localStorage.getItem('token');
let socket = null;
let currentSession = null;
let isStreaming = false;

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
const sidebar = document.getElementById('sidebar');
const toggleSidebarBtn = document.getElementById('toggle-sidebar');

let isSidebarVisible = true;

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
    if (currentSession) {
      currentSession.messages.push(msg);
      renderMessages();
    }
  });

  socket.on('stream_chunk', (chunk) => {
    if (currentSession && currentSession.messages.length > 0) {
      const lastMsg = currentSession.messages[currentSession.messages.length - 1];
      if (lastMsg.role === 'assistant') {
        lastMsg.content += chunk;
        appendToLastMessage(chunk);
      }
    }
  });

  socket.on('stream_end', () => {
    isStreaming = false;
    sendBtn.textContent = 'Send';
    sendBtn.disabled = false;
    interruptBtn.style.display = 'none';
    removeTypingIndicator();
    loadSessions();
  });

  socket.on('stream_error', (error) => {
    console.error('Stream error:', error);
    isStreaming = false;
    sendBtn.textContent = 'Send';
    sendBtn.disabled = false;
    interruptBtn.style.display = 'none';
    removeTypingIndicator();
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
  if (!currentSession) return;

  sessionTitle.textContent = currentSession.title || 'Untitled';
  renderMessages();
}

function renderMessages() {
  if (!currentSession) return;

  messagesContainer.innerHTML = '';

  for (const msg of currentSession.messages) {
    const bubble = document.createElement('div');
    bubble.className = `message-bubble ${msg.role}`;

    // 头像
    const avatar = document.createElement('div');
    avatar.className = 'message-avatar';
    avatar.textContent = msg.role === 'user' ? 'ME' : 'AI';
    bubble.appendChild(avatar);

    // 内容包装器
    const wrapper = document.createElement('div');
    wrapper.className = 'message-content-wrapper';

    // 消息信息
    const info = document.createElement('div');
    info.className = 'message-info';

    const sender = document.createElement('span');
    sender.className = 'message-sender';
    sender.textContent = msg.role === 'user' ? '你' : 'Claude';

    const time = document.createElement('span');
    time.className = 'message-time';
    time.textContent = new Date(msg.timestamp).toLocaleTimeString('zh-CN', {
      hour: '2-digit',
      minute: '2-digit'
    });

    info.appendChild(sender);
    info.appendChild(time);
    wrapper.appendChild(info);

    // 消息内容
    const content = document.createElement('div');
    content.className = 'message-content';
    content.textContent = msg.content;

    wrapper.appendChild(content);
    bubble.appendChild(wrapper);
    messagesContainer.appendChild(bubble);
  }

  if (isStreaming) {
    addTypingIndicator();
  }

  messagesContainer.scrollTop = messagesContainer.scrollHeight;
}

function appendToLastMessage(text) {
  const lastBubble = messagesContainer.querySelector('.message-bubble.assistant:last-child .message-content');
  if (lastBubble) {
    lastBubble.textContent += text;
    messagesContainer.scrollTop = messagesContainer.scrollHeight;
  }
}

function addTypingIndicator() {
  const indicator = document.createElement('div');
  indicator.id = 'typing-indicator';
  indicator.className = 'message-bubble assistant';

  // 头像
  const avatar = document.createElement('div');
  avatar.className = 'message-avatar';
  avatar.textContent = 'AI';
  indicator.appendChild(avatar);

  // 内容包装器
  const wrapper = document.createElement('div');
  wrapper.className = 'message-content-wrapper';

  // 消息信息
  const info = document.createElement('div');
  info.className = 'message-info';

  const sender = document.createElement('span');
  sender.className = 'message-sender';
  sender.textContent = 'Claude';

  info.appendChild(sender);
  wrapper.appendChild(info);

  // 输入指示器
  const content = document.createElement('div');
  content.className = 'message-content';
  content.innerHTML = '<div class="typing-indicator"><span></span><span></span><span></span></div>';

  wrapper.appendChild(content);
  indicator.appendChild(wrapper);
  messagesContainer.appendChild(indicator);
  messagesContainer.scrollTop = messagesContainer.scrollHeight;
}

function removeTypingIndicator() {
  const indicator = document.getElementById('typing-indicator');
  if (indicator) {
    indicator.remove();
  }
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

  for (const session of sessions) {
    const li = document.createElement('li');
    li.className = 'session-item';
    li.dataset.id = session.id;

    const title = document.createElement('div');
    title.className = 'session-item-title';
    title.textContent = session.title || 'Untitled';

    const date = document.createElement('div');
    date.className = 'session-item-date';
    date.textContent = new Date(session.updatedAt).toLocaleString();

    li.appendChild(title);
    li.appendChild(date);

    li.addEventListener('click', () => {
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

toggleSidebarBtn.addEventListener('click', () => {
  isSidebarVisible = !isSidebarVisible;
  sidebar.style.display = isSidebarVisible ? 'flex' : 'none';
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
