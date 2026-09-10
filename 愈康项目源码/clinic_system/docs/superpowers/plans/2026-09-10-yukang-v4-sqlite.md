# 愈康 v4.0 SQLite 持久化实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [x]`) syntax for tracking.

**Goal:** 在不改变现有 HTTP API 和页面行为的前提下，将业务持久化从按账号 JSON 文件升级为 SQLite，并提供首次迁移、每日备份和运行状态查询。

**Architecture:** 保持当前本地 B/S 架构：浏览器 → Express routes → services → sqliteRepository。SQLite 使用 Node 22 内置 `node:sqlite`，不新增 npm/native 依赖；旧 JSON 首次启动只读导入，原文件保留作为回滚证据。

**Tech Stack:** Node.js 22+、Express、内置 `node:sqlite`、node:test、SQLite WAL、`VACUUM INTO` 备份。

**Spec:** 用户于 2026-09-10 确认采用“SQLite 稳定性、自动备份、保留浏览器架构、RAG 后续升级”的推广优先方案。

## Global Constraints

- 所有新增依赖、模型、缓存优先放 `D:\`；本轮不新增第三方依赖。
- 不删除或覆盖旧 JSON 数据；迁移失败时服务器必须拒绝启动，不能带病运行。
- 保持现有 URL、请求体和响应体不变。
- 数据库、备份和迁移报告必须位于 `DATA_DIR`。
- 每个新增能力先写失败测试，再实现，再跑完整回归。

---

### Task 1: SQLite 仓储与旧数据迁移

**Files:**
- Create: `src/repository/sqliteRepository.js`
- Modify: `src/repository/fileRepository.js`
- Test: `tests/sqliteRepository.test.js`

**Interfaces:**
- Produces: `createRepository(dataDir)`, `initRootStorage()`, `readUsers()`, `writeUsers(users)`, `initUserStorage(username)`, `readCollection(username, collection)`, `writeCollection(username, collection, data)`, `createBackup(reason)`, `listBackups()`, `getStatus()`, `close()`.
- `readUsers()` 返回原数组结构；`readCollection()`/`writeCollection()` 保持现签名。

- [x] **Step 1: 写迁移、读写和幂等测试**
- [x] **Step 2: 运行测试确认因模块缺失失败**
- [x] **Step 3: 实现 SQLite schema、迁移、事务写入和兼容导出**
- [x] **Step 4: 运行测试确认通过**

### Task 2: 备份和运行状态

**Files:**
- Modify: `src/repository/sqliteRepository.js`
- Modify: `server.js`
- Test: `tests/sqliteRepository.test.js`

- [x] **Step 1: 写备份文件可打开且保留策略测试**
- [x] **Step 2: 运行测试确认失败**
- [x] **Step 3: 实现每日自动备份、手动备份和状态查询**
- [x] **Step 4: 运行测试确认通过**

### Task 3: 回归与文档

**Files:**
- Modify: `regression-test.js`
- Modify: `package.json`
- Modify: `README.md`
- Modify: `.gitignore`

- [x] **Step 1: 将回归测试的明文账号迁移检查改为 SQLite 检查**
- [x] **Step 2: 运行旧版 79 项回归**
- [x] **Step 3: 更新架构、备份、迁移说明和忽略规则**
- [x] **Step 4: 跑 Node 测试、语法检查和服务启动验证**
