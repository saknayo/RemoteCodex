# public 目录规则

## 必须遵守的规则

1. **CSS 版本号管理**
   - 修改 `style.css` 后，必须同步更新 `index.html` 中的版本号
   - 格式：`href="/style.css?v=2"`（每次修改递增版本号）
   - 原因：防止浏览器缓存导致用户看不到更新

2. **文件命名约定**
   - `index.html` - 主页面
   - `style.css` - 样式文件
   - `app.js` - 前端逻辑

3. **设计规范**
   - 参考 Clowder AI 的 Cat Cafe 设计系统
   - 使用 CSS 变量定义颜色和间距
   - 保持温暖奶油色系风格

4. **移动端适配**
   - 使用媒体查询 `@media (max-width: 768px)`
   - 确保所有元素在小屏幕上可用

## 父级规则

遵循项目根目录 `CLAUDE.md` 中的所有规则。
