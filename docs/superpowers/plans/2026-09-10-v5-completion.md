# v5.0 商业闭环实施计划

> 按用户指定顺序推进：RBAC -> Edge 自动升级与回滚 -> 全量知识包 -> mTLS 私有 CA -> 试点验收模板。

**Goal:** 将当前 v5.0 预览版推进为具备权限边界、可自动升级回滚、完整知识包、可验证 mTLS 和真实试点验收流程的商业底座。

**Architecture:** 控制面继续采用 FastAPI + SQLAlchemy + Alembic，平台密钥保留为超级管理员，成员使用可撤销令牌与角色权限；Edge 更新器采用“验签下载 -> 安全解压 -> 备份 -> 应用 -> 健康检查 -> 失败回滚”状态机；知识索引在 D: 构建并打包分发；mTLS 使用用户自有 CA/证书，仓库只提供生成与验证工具；试点验收使用可复核记录模板。

**Tech Stack:** FastAPI、SQLAlchemy、Alembic、pytest、Node.js、node:test、SQLite FTS5、FastEmbed、cryptography。

## Global Constraints

- 所有下载、模型、证书、生成索引和发布包默认放 `D:\`。
- 不提交真实密钥、证书、患者数据、数据库或完整运行时索引。
- 所有新增能力先写失败测试，再实现，再跑完整回归。
- `X-Platform-Key` 保持超级管理员兼容；成员令牌使用 `X-User-Token`。
- 更新失败必须恢复旧版本并回报 `rolled_back`，不得留下半升级状态。
- 未完成真实诊所试点前，不宣称 v5.0 正式商业发布。

---

### Task 1: RBAC 强制权限与组织/门店范围

**Files:**
- Modify: `cloud_control_plane/app/models.py`
- Modify: `cloud_control_plane/app/schemas.py`
- Modify: `cloud_control_plane/app/security.py`
- Modify: `cloud_control_plane/app/api.py`
- Create: `cloud_control_plane/alembic/versions/20260910_rbac_user_tokens.py`
- Modify: `cloud_control_plane/tests/test_control_plane.py`
- Modify: `cloud_control_plane/admin/app.js` and `cloud_control_plane/admin/index.html`

**Interfaces:**
- `Principal(kind, role, org_id, clinic_id, user_id)`
- `require_permission(permission)` FastAPI dependency
- `POST /api/v1/users/{user_id}/token` rotates and returns a one-time visible member token
- Permission map: `platform_admin` all; `org_owner` scoped writes/reads; `store_manager` clinic reads/lookups; `doctor` clinic read/lookup create; `pharmacist` clinic read; `finance` aggregate read; `auditor` read-only audit/dashboard/edge.

- [x] Write failing tests for no token, wrong role, cross-org and cross-clinic access.
- [x] Add token hash fields and migration.
- [x] Implement token issue/verify, permission map and scope helpers.
- [x] Apply dependencies/filters to admin APIs.
- [x] Run control-plane tests and update preview docs.

### Task 2: Edge 自动升级、健康检查与失败回滚

**Files:**
- Create: `愈康项目源码/clinic_system/src/services/updateService.js`
- Modify: `愈康项目源码/clinic_system/src/services/edgeAgentService.js`
- Create: `愈康项目源码/clinic_system/tests/updateService.test.js`
- Modify: `愈康项目源码/clinic_system/tests/edgeAgentService.test.js`
- Modify: `cloud_control_plane/app/edge_ws.py` if state handling is required.

**Interfaces:**
- `applyRelease({ zipPath, appDir, manifest, runCommand, healthCheck, fsOps })`
- Returns `{ status: 'healthy'|'rolled_back', backupPath, health }`
- Update package manifest: `update-manifest.json` with `app_dir`, `restart_command`, `healthcheck`, optional `migrate_command`.

- [x] Write failing tests for successful apply, health failure rollback, invalid package and path traversal.
- [x] Implement safe extraction, backup, apply, restart, health poll and rollback.
- [x] Connect EdgeAgent job states: verified -> staged -> applying -> healthy/rolled_back/failed.
- [x] Run Node unit and real control-plane/Edge integration tests.

### Task 3: 全量知识包构建与发布

**Files:**
- Create: `愈康项目源码/clinic_system/tools/build_knowledge_package.js`
- Modify: `愈康项目源码/clinic_system/tools/build_hybrid_index.js`
- Create: `愈康项目源码/clinic_system/tools/build_hybrid_index_gpu.py`
- Modify: `愈康项目源码/clinic_system/package.json`
- Modify: `local_rag_worker/README.md`

**Interfaces:**
- `build_knowledge_package.js --output D:\YukangKnowledge --device cpu|gpu`
- Output: `knowledge_index.db`, `knowledge_manifest.json`, `knowledge-package.zip`
- Manifest records source rows, chunk count, dimension, model, build time and SHA-256.

- [x] Extract complete `14638` rows and build on CPU in D: to verify pipeline.
- [x] Add optional CUDA path for GPU environments with CPU fallback.
- [x] Generate and verify package manifest and checksums.
- [x] Document distribution/install/rollback.

### Task 4: mTLS 私有 CA、证书生成与验证

**Files:**
- Create: `cloud_control_plane/scripts/generate_mtls_ca.py`
- Create: `cloud_control_plane/scripts/verify_mtls_certificates.py`
- Modify: `cloud_control_plane/nginx/nginx.conf` if needed
- Modify: `cloud_control_plane/.env.example`
- Modify: `cloud_control_plane/README.md`
- Test: `cloud_control_plane/tests/test_mtls_certificates.py`

**Interfaces:**
- `generate_mtls_ca.py --output D:\YukangCerts --host control.example.com`
- Generates CA, server cert/key and edge client cert/key outside repo.
- Verification checks SAN, EKU, chain and private-key match.

- [x] Write failing certificate tests.
- [x] Implement private CA and certificate generation.
- [x] Add chain and hostname verification.
- [x] Validate Nginx configuration and document production replacement.

### Task 5: 真实诊所试点验收模板

**Files:**
- Create: `docs/pilot-acceptance.md`
- Create: `docs/pilot-feedback-template.csv`
- Modify: `README.md`

**Interfaces:**
- Checklist covers consent, privacy, roles, reception/prescription/pharmacy flows, backup, upgrade rollback, metrics and issue escalation.

- [x] Define measurable pilot gates.
- [x] Add daily feedback and incident templates.
- [x] Add go/no-go and sign-off rules.
- [x] Mark pilot as pending until real clinic evidence is entered.
