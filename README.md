# Artmatic

![Artmatic](https://repository-images.githubusercontent.com/1434279699/fce58e38-9749-439f-a173-25ef3c29f7ea)

Artmatic 是一款面向算法艺术与故障艺术的 Web 原生开源剪辑软件，有丰富的内置特效库和生成器，并支持 AI Agent 实时编辑工程。

---

## 快速开始

```bash
npx artmatic          # 不安装，直接起本地服务并打开 WebUI
npm i -g artmatic     # 或者装在全局，之后敲 `artmatic`
```

需要 Node.js 20.19+ 与 Chrome / Edge（File System Access API）。`artmatic --help` 可改端口、关掉自动开浏览器。

---

## 从源码开发

```bash
pnpm install

# 开发
pnpm run dev
pnpm run check        # 类型检查
pnpm run test         # 单元测试
pnpm run test:e2e     # Playwright 端到端测试（使用本机 Chrome 浏览器）

# 构建与本地预览
pnpm run build
pnpm run preview

# 打包为桌面版
pnpm run desktop:artifact
pnpm run desktop:smoke
```

---

## 环境依赖（WebUI）

Artmatic 可以完全在浏览器上运行。开发此项目需要配置下列环境。

| 项 | 要求 |
|---|---|
| 运行时 | Node.js 20.19+ / 22.12+ |
| 包管理器 | [pnpm](https://pnpm.io) 12+ |
| 浏览器 | 由于使用 File System Access API，除了 Chromium 系之外的浏览器支持度有限。 |
| 部署 | 无后端，`build` 产物是纯静态文件，可放任意静态托管 |

---

## 许可与致谢

本项目以 **Apache License 2.0** 授权，全文见 [LICENSE](LICENSE)。

引入的第三方依赖与移植代码各自保留原许可，见 [CREDITS.md](CREDITS.md)。

This project is NOT affiliated with U&I Software ArtMatic.
