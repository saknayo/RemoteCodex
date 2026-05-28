## 目录结构

```
remote_codex/
├── CLAUDE.md          # 项目规则（所有工作前必读）
├── AGENTS.md          # Agent 配置说明
├── readme.md          # 本文件
├── package.json       # Node.js 依赖配置
├── server.js          # Web 服务器主程序
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
└── disscuss/          # 方案讨论归档目录
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

**安全配置：**
- 登录间隔：30秒
- 失败封禁：3次失败封禁IP 30分钟
- 速率限制：10次/分钟
