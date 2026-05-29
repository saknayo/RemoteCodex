## 目录结构

```
remote_codex/
├── CLAUDE.md          # 项目规则（所有工作前必读）
├── AGENTS.md          # Agent 配置说明
├── readme.md          # 本文件
├── package.json       # Node.js 依赖配置
├── server.js          # Web 服务器主程序（支持 Claude/Codex CLI）
├── .env.example       # 环境配置模板
├── .gitignore         # Git 忽略配置
│
├── middleware/        # 中间件
│   ├── auth.js        # JWT 认证中间件
│   └── security.js    # 安全防护中间件（IP封禁、速率限制）
│
├── routes/            # API 路由
│   └── auth.js        # 认证相关路由
│
├── utils/             # 工具模块
│   ├── jwt.js         # JWT 工具
│   └── password.js    # 密码工具（bcrypt）
│
├── storage/           # 数据存储
│   ├── users.json     # 用户数据
│   └── bans.json      # IP 封禁记录
│
├── public/            # 前端静态文件
│   ├── index.html     # 主页面
│   ├── style.css      # 样式
│   └── app.js         # 前端逻辑
│
├── sessions/          # 会话存储目录（运行时生成）
│
└── discuss/           # 方案讨论归档目录
    └── readme.md      # 归档使用说明
```

### 开发工作

**首次启动：**
1. 复制配置：`cp .env.example .env`
2. 编辑 `.env` 设置管理员密码和 JWT 密钥
3. 安装依赖：`npm install`
4. 启动服务：`npm start`

**日常使用：**
- 启动服务：`npm start`
- 开发模式：`npm run dev`

**公网临时访问：**
- 一键启动本机 Web 服务和反向 SSH 隧道：`./remote_codex.sh start`
- 查看运行状态：`./remote_codex.sh status`
- 查看日志：`./remote_codex.sh logs`
- 快速关闭公网暴露和本机服务：`./remote_codex.sh stop`
- 先在本机 `.env` 中配置 `PUBLIC_HOST`，也可配置 `PUBLIC_USER`、`PUBLIC_PORT`、`APP_PORT`
- 默认隧道：公网服务器 `0.0.0.0:${PUBLIC_PORT}` 转发到本机 `127.0.0.1:${APP_PORT}`
- `.env` 已被 `.gitignore` 忽略，适合保存公网服务器地址等私有配置

**安全配置：**
- 登录间隔：30秒
- 失败封禁：3次失败封禁IP 30分钟
- 速率限制：10次/分钟

**CLI 配置：**
- 默认使用 Claude CLI：`CLI_PROVIDER=claude`
- 使用 Codex CLI：`CLI_PROVIDER=codex`
- Claude 路径：`CLAUDE_CLI_PATH=/path/to/claude`
- Codex 路径：`CODEX_CLI_PATH=/path/to/codex`
- 旧的 `CLI_PATH` 仍可作为 Claude 路径兼容配置
- 新建 Session 时可选择 Claude/Codex，输入自定义 Session 名和项目目录；CLI 会在该目录下运行
