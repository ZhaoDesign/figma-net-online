# Figma Net Online

一个现代化的在线 Figma 网络线路诊断工具：网页负责交互和展示，本地助手负责真实 DNS / HTTPS 测速以及 Hosts 文件操作。

## 当前结构

- `dist/`：可直接部署到静态托管的网页。
- `helper/`：跨 macOS / Windows 的 Node.js 本地助手源码。
- `.openai/hosting.json`：Sites 部署配置。

## 本地运行网页

```bash
python3 -m http.server 4173 --directory dist
```

打开 <http://127.0.0.1:4173/>。如果只想查看交互预览，可打开 `http://127.0.0.1:4173/?demo=1`。

## 本地助手

Node.js 18 或更高版本：

```bash
cd helper
npm start
```

助手只监听 `127.0.0.1:47821`。它提供：

- 当前平台和 Hosts 路径检测；
- 快速 / 全面模式 DNS 解析和真实 HTTPS 延迟测试；
- Figma 相关 Hosts 读取、应用和重置；
- 仅允许已配置的网站来源发起请求。

在 macOS / Windows 上真正写入 Hosts 时，启动助手的进程必须拥有管理员权限。正式发布时应将它打包成签名的安装包，由安装器处理权限和开机启动；网页首次访问只需要用户确认一次安装。

## 重要边界

纯浏览器无法直接修改本机 Hosts。公开网页与本地助手的组合才可以同时保持“一键操作”和系统安全边界。网页默认在未检测到助手时展示安装引导，不会伪造测速结果。
