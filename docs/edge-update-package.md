# Edge 更新包格式

更新包是 ZIP 文件，根目录必须包含 `update-manifest.json`。

```json
{
  "version": "4.3.0",
  "app_dir": "clinic_system",
  "restart_command": ["cmd.exe", "/c", "start", "YuKangClinic", "/min", "cmd.exe", "/c", "start.bat"],
  "healthcheck": {
    "url": "http://127.0.0.1:3002/api/server-info",
    "timeout_ms": 60000,
    "interval_ms": 2000
  }
}
```

执行流程：

1. 控制面签名发布清单，并下发 `job_offer`。
2. Edge 验证 Ed25519 签名和 SHA-256。
3. Edge 安全解压，拒绝绝对路径、盘符路径和 `..` 越界路径。
4. Edge 备份当前 `YUKONG_APP_DIR`。
5. 应用新文件，执行可选迁移命令和重启命令。
6. 健康检查失败时恢复备份并再次执行重启命令，回报 `rolled_back`。
