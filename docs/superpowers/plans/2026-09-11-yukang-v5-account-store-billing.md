# 愈康 v5.0 账号、门店、收费与恢复实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** 完成账号与门店隔离、收费状态机、收费单打印和图形化一键恢复，并重构登录与主界面视觉。

**Architecture:** 独立控制库存账号、组织和邀请；每个门店使用独立 SQLite 业务库；认证中间件通过 AsyncLocalStorage 把请求绑定到门店仓储。收费以 `billing` 为状态源，确认后兼容写入 `revenue`。

**Tech Stack:** Node.js 22.5+、Express、node:sqlite、原生 HTML/CSS/JavaScript、node:test。

**Spec:** `docs/superpowers/specs/2026-09-11-yukang-v5-account-store-billing-design.md`

## Global Constraints

- 所有测试和运行时新增数据写入 `D:\CodexTemp` 或项目数据目录，不写入系统盘临时目录。
- 所有新增功能先写失败测试，再实现。
- 旧账号首次登录自动迁移到独立门店库。
- 身份证、门店权限和收费确认必须在服务端校验。
- 不直接使用参考图、水印或 photo-abstract-editorial 的任何受限制资产。

### Task 1: 控制库与门店仓储

**Files:** Create `src/repository/controlRepository.js`, modify `src/repository/sqliteRepository.js`, test `tests/accountStore.test.js`.

**Interfaces:** `createControlRepository`, `controlRepository.registerAccount`, `login`, `createInvite`, `getUser`, `listClinics`; `repo.initStore`, `repo.runWithStore`, `repo.readStoreCollection`.

- [ ] Write tests for registration, one-time invite, encrypted ID card, and store isolation.
- [ ] Implement control schema and account methods.
- [ ] Implement store context routing and legacy data migration.
- [ ] Run `npm test`.

### Task 2: 认证 API 与门店控制台

**Files:** Modify `src/services/authService.js`, `src/routes/authRoutes.js`, create `src/services/accountService.js`, `src/routes/accountRoutes.js`, `server.js`.

**Interfaces:** `POST /api/auth/register`, `POST /api/auth/login`, `GET /api/account/me`, `GET /api/clinics/overview`, `POST /api/clinics/invites`.

- [ ] Write failing API tests for profile fields, headquarters dashboard and branch denial.
- [ ] Bind sessions to org/clinic and sanitize profiles.
- [ ] Implement aggregate overview and invite endpoints.
- [ ] Run tests.

### Task 3: 收费状态机

**Files:** Create `src/services/billingService.js`, `src/routes/billingRoutes.js`, modify `visitService.js`, `server.js`, `tests/billing.test.js`.

**Interfaces:** `GET /api/billing`, `POST /api/billing/:id/pay`, `POST /api/billing/:id/print`.

- [ ] Write failing tests for no revenue on visit, payment, duplicate payment, change calculation and print count.
- [ ] Remove automatic revenue write and create pending bills.
- [ ] Implement payment and revenue compatibility write.
- [ ] Run tests and regression.

### Task 4: 图形化恢复

**Files:** Modify `index.html` settings section, `src/services/systemService.js`, `tests/systemRestore.test.js`.

- [ ] Write failing tests for restore filename validation, confirmation and rollback.
- [ ] Add scoped backup list/create/restore UI.
- [ ] Clear session and return to login after successful restore.
- [ ] Run tests.

### Task 5: UI 重构与验证

**Files:** Replace `login.html`; modify `index.html`; create `DESIGN.md`, `.impeccable/design.json`.

- [ ] Implement original mountain/herb login composition and responsive registration.
- [ ] Add billing and headquarters store views.
- [ ] Apply design tokens, states, focus and print styles.
- [ ] Run the Impeccable detector and capture desktop/mobile screenshots.
- [ ] Run `node --check`, `npm test`, `regression-test.js`, and live HTTP checks.