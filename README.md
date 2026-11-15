# Batch Transmitter Desktop

本地钱包管理、账户表格导入和批量交易管理的 Electron 桌面端。 当前版本 1.0.8。

通过标准代币接口和用户配置的目标执行批量任务。应用包含 XLSX 账户模板、交易记录及链上回执核对。

## 开发与构建

使用 Node.js 24、npm 和 Electron 44.5.1。

```powershell
npm ci
npm test
npm run smoke
npm run dist:win
```

源码位于 `src/` 和 `renderer/`。Windows x64 安装包生成在 `dist/`。启动检查使用独立的临时配置和本地测试输入。

## 许可

项目采用 [MIT 许可证](LICENSE)。第三方许可和归属见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。
