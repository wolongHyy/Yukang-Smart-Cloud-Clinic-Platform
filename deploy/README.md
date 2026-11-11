# 愈康官网部署手册

本文说明如何把 `website/` 中的愈康产品官网部署到阿里云 ECS，并绑定已购买的域名。

> 重要边界：这里部署的是**公开静态官网**，不是诊所业务系统。`website/` 不含患者数据、SQLite、账号密码、医生端或患者端登录入口。诊所业务系统仍应只部署在本机或可信局域网，不能因为买了服务器就把它直接暴露到公网。

## 当前部署状态（2026-11-11）

本次上线对象为 `yukangclinic.cn`，只部署 `website/` 静态产品官网，不部署诊所业务系统。

| 项目 | 当前状态 | 证据 / 说明 |
| --- | --- | --- |
| 阿里云 ECS | 运行中 | 实例 `i-bp196vs9fbel20xdzi7p`，华东1（杭州），Alibaba Cloud Linux 3，2 vCPU / 2 GiB，到期日 2027-11-12 |
| Nginx | 已安装并开机启动 | 监听 HTTP 80；配置测试通过 |
| 发布目录 | 已按发布结构部署 | `/var/www/yukang-site/current` 指向 `/var/www/yukang-site/releases/20261111T085932Z` |
| HTTP 临时验证 | 已实测返回 200 | <http://120.55.116.160/>；页面标题和静态资源已验证 |
| 安全组 | 已放行 80、443 | 443/TCP 入方向已复查；22、3389 的现有规则未改动 |
| ICP 备案 | 阿里云初审中 | 订单 `2031878284929` 已于 2026-11-11 16:44 提交；审核通过前不添加 A 记录、不宣称备案完成 |
| DNS A 记录 | 尚未添加 | 等待 ICP 备案审核通过后再执行第 4 节 |
| HTTPS 证书 | 尚未签发 | `certbot 1.22.0` 与 `certbot-renew.timer` 已安装；等待 DNS 生效后申请 |
| 旧 ECS | 保留未释放 | 新服务器和 HTTPS 全链路验收前，不停止或释放旧实例 |

> 结论：目前只有 HTTP 预部署已经完成，**ICP 备案、DNS 和 HTTPS 还没有完成**。临时 IP 地址不能替代正式域名上线。

---

## 1. 上线后的结构

```text
浏览器
  │
  ├─ https://你的域名
  │      │
  │      └─ 阿里云 DNS A 记录
  │             │
  │             └─ 阿里云 ECS
  │                    └─ Nginx
  │                         └─ /var/www/yukang-site/current
  │                              ├─ index.html
  │                              ├─ styles.css
  │                              ├─ script.js
  │                              └─ favicon.svg
  │
  └─ 诊所业务系统：继续留在本机 / 可信局域网，不在此次公网部署范围内
```

本项目采用常见的静态站上线方式：

1. 静态 HTML/CSS/JS 打包；
2. 上传到 ECS；
3. Nginx 提供 80/443 端口；
4. Let's Encrypt 自动申请 HTTPS 证书；
5. 阿里云 DNS 把域名指向 ECS 公网 IPv4。

没有引入数据库、Node 服务或公网管理后台，因此攻击面和维护成本比把整套业务系统搬上公网低得多。

---

## 2. 开始前需要准备什么

请先把下面 7 项信息准备好。**不要把 SSH 私钥内容直接发到聊天里**，只需要在本机给出私钥文件路径。

| 项目 | 在哪里获取 | 示例 |
| --- | --- | --- |
| ECS 公网 IPv4 | 阿里云控制台 → 云服务器 ECS → 实例详情 | `47.100.1.2` |
| SSH 用户名 | 创建实例时选择；常见为 `root` 或 `ecs-user` | `root` |
| SSH 私钥 | 创建实例时下载的 `.pem` 文件；建议放在 `D:\Keys\` | `D:\Keys\aliyun.pem` |
| 主域名 | 阿里云域名控制台 | `example.com` |
| 是否配置 `www` | 自己决定；建议一起配置 | `www.example.com` |
| 证书通知邮箱 | 常用邮箱即可 | `admin@example.com` |
| 备案状态 | 阿里云 ICP 代备案系统 | 已备案 / 未备案 |

### 域名和大区的关系

- **ECS 在中国大陆地域**：域名通过 80/443 对外提供网站前，通常必须先完成 ICP 备案。未备案时，阿里云可能拦截或限制网站访问。请先在阿里云办理备案，再继续。
- **ECS 在中国香港或海外地域**：通常不需要中国大陆 ICP 备案，但访问速度、跨境网络稳定性和合规要求不同，仍应按实际业务所在地确认。
- 域名需要完成实名认证，并处于正常状态。
- 网站正式上线后，应按所在地要求办理公安联网备案等手续；具体时限和材料以当地主管部门要求为准。

---

## 3. 配置阿里云安全组

进入：

`阿里云控制台 → 云服务器 ECS → 实例 → 安全组 → 配置规则 → 入方向`

至少添加：

| 端口 | 协议 | 授权对象 | 用途 |
| --- | --- | --- | --- |
| `22` | TCP | 你的家庭/公司公网 IP `/32` | SSH 部署与维护 |
| `80` | TCP | `0.0.0.0/0` | HTTP 和证书验证 |
| `443` | TCP | `0.0.0.0/0` | HTTPS |

建议：

- 不要把 `22` 长期开放给 `0.0.0.0/0`；
- 不要开放诊所业务系统端口，例如 `3002`；
- 不需要开放数据库端口；
- 如果系统内还启用了 `ufw` 或 `firewalld`，也要同步放行 80/443。部署脚本**不会自动修改防火墙**，避免误伤服务器上已有服务。

---

## 4. 在阿里云 DNS 添加解析

打开：

<https://dnsnext.console.aliyun.com/authoritative>

选择你的域名，然后添加：

| 主机记录 | 记录类型 | 记录值 | TTL |
| --- | --- | --- | --- |
| `@` | `A` | ECS 公网 IPv4 | `600` |
| `www` | `A` | ECS 公网 IPv4 | `600` |

`www` 也可以配置为 CNAME 指向 `@`，但 A 记录更直观。首次上线建议 TTL 使用 600 秒，等稳定后再考虑延长。

配置后在 Windows PowerShell 检查：

```powershell
Resolve-DnsName example.com -Type A
Resolve-DnsName www.example.com -Type A
```

返回值中应出现 ECS 公网 IPv4。

---

## 5. 检查 SSH 连接

先在本机确认 Windows 已安装 OpenSSH：

```powershell
ssh -V
scp -V
```

测试登录：

```powershell
ssh -i 'D:\Keys\aliyun.pem' root@47.100.1.2
```

如果提示私钥权限过宽，请在服务器控制台或本机调整私钥 ACL，只允许当前 Windows 用户读取。不要把私钥提交到 Git，也不要把私钥上传到网站目录。

退出服务器：

```bash
exit
```

---

## 6. 一键部署

在项目根目录执行：

```powershell
powershell -ExecutionPolicy Bypass -File .\deploy\deploy.ps1 `
  -ServerHost '47.100.1.2' `
  -User 'root' `
  -KeyPath 'D:\Keys\aliyun.pem' `
  -Domain 'example.com' `
  -Email 'admin@example.com' `
  -IncludeWww
```

如果还没配好 HTTPS，只想先验证 HTTP：

```powershell
powershell -ExecutionPolicy Bypass -File .\deploy\deploy.ps1 `
  -ServerHost '47.100.1.2' `
  -User 'root' `
  -KeyPath 'D:\Keys\aliyun.pem' `
  -Domain 'example.com' `
  -SkipTls
```

只检查本地参数、不连接服务器：

```powershell
powershell -ExecutionPolicy Bypass -File .\deploy\deploy.ps1 `
  -ServerHost '47.100.1.2' `
  -User 'root' `
  -KeyPath 'D:\Keys\aliyun.pem' `
  -Domain 'example.com' `
  -Email 'admin@example.com' `
  -PlanOnly
```

### 脚本会做什么

1. 在 `D:\CodexTemp\yukang-site-deploy` 建立临时打包目录；
2. 只打包 `website/`；
3. 通过 SSH/SCP 上传到 ECS 的 `/tmp/yukang-site-时间戳/`；
4. 在服务器安装 Nginx、rsync、curl 和 Certbot（按系统包管理器）；
5. 把站点发布到 `/var/www/yukang-site/releases/时间戳/`；
6. 把 `/var/www/yukang-site/current` 原子切换到最新版本；
7. 只新增 `yukang-site.conf`，不覆盖服务器上的其他站点；
8. 执行 `nginx -t`，通过后重载 Nginx；
9. 检查域名是否解析到服务器公网 IP；
10. 调用 Certbot 申请证书并启用 HTTP→HTTPS 跳转；
11. 在服务器本机检查 HTTP/HTTPS 健康状态；
12. 清理本机与服务器的临时上传目录。

### 脚本不会做什么

- 不会上传 `愈康项目源码/`、`cloud_control_plane/`、`local_rag_worker/`；
- 不会上传数据库、患者资料、日志、`.env` 或私钥；
- 不会把诊所业务系统暴露到公网；
- 不会自动修改阿里云安全组；
- 不会自动修改 ECS 内的防火墙；
- 不会自动购买域名、证书或服务器；
- 不会替你完成 ICP 备案。

---

## 7. 上线后验证

### 浏览器检查

打开：

```text
https://example.com/
https://www.example.com/
```

确认：

- 页面标题是“愈康云诊所｜本地优先的诊所数字化工作台”；
- 页面样式、动画和手机菜单正常；
- 地址栏显示有效 HTTPS 证书；
- HTTP 会自动跳转到 HTTPS。

### PowerShell 检查

```powershell
Resolve-DnsName example.com -Type A

curl.exe --ssl-no-revoke -I https://example.com/
curl.exe --ssl-no-revoke -I http://example.com/
```

正常结果：

- HTTP 返回 `301` 或 `308`，并跳转到 HTTPS；
- HTTPS 返回 `200`；
- 证书域名与访问域名一致；
- 没有证书警告。

站点健康检查：

```powershell
curl.exe --ssl-no-revoke https://example.com/healthz
```

应返回：

```text
ok
```

### 常见安全响应头

```powershell
curl.exe --ssl-no-revoke -I https://example.com/
```

响应中应看到：

- `Content-Security-Policy`
- `X-Content-Type-Options: nosniff`
- `X-Frame-Options: DENY`
- `Referrer-Policy`
- `Permissions-Policy`
- `Strict-Transport-Security`

---

## 8. 更新官网

修改 `website/` 后，重新执行同一条部署命令即可。每次发布会生成新目录，旧版本保留在：

```text
/var/www/yukang-site/releases/
```

`current` 是指向当前版本的软链接，切换几乎是原子的，不需要删除旧版本。

---

## 9. 回滚到上一个版本

SSH 登录服务器后查看发布记录：

```bash
ls -1dt /var/www/yukang-site/releases/*
```

把 `<上一个版本目录>` 替换成实际路径：

```bash
ln -sfn /var/www/yukang-site/releases/<上一个版本目录> /var/www/yukang-site/current.new
mv -Tf /var/www/yukang-site/current.new /var/www/yukang-site/current
nginx -t
systemctl reload nginx
```

如果手动切换失败，先不要删除任何目录，保留现场再排查。

---

## 10. 故障排查

### 浏览器打不开域名

依次检查：

```powershell
Resolve-DnsName example.com -Type A
Test-NetConnection example.com -Port 80
Test-NetConnection example.com -Port 443
```

再检查：

1. 阿里云 DNS 是否有正确的 A 记录；
2. ECS 安全组是否放行 80/443；
3. 域名是否已备案（中国大陆 ECS）；
4. ECS 内 `ufw` / `firewalld` 是否放行；
5. Nginx 是否正在运行。

服务器上检查：

```bash
systemctl status nginx --no-pager
nginx -t
curl -I -H 'Host: example.com' http://127.0.0.1/
tail -n 100 /var/log/nginx/yukang-site.error.log
```

### HTTPS 证书申请失败

常见原因：

- DNS 还没生效；
- 安全组没有放行 80；
- 域名已开启代理/CDN，导致验证路径被改变；
- 同一域名已有其他 Nginx 站点配置冲突；
- 域名未备案或访问被拦截；
- Certbot 找不到 `python3-certbot-nginx`。

重新检查 DNS 和端口后再运行：

```bash
sudo certbot --nginx -d example.com -d www.example.com
```

如果服务器上有其他网站，先确认我们的配置没有覆盖它们：

```bash
nginx -T | grep -n "server_name"
```

### `nginx -t` 报其他站点错误

部署脚本会在配置失败时恢复原来的 `yukang-site.conf`。如果错误来自服务器上原本就存在的其他站点，需要先修复那个站点的配置，再重新部署。

### SSH 提示 `Permission denied`

- 确认 `-User` 与创建 ECS 时选择的用户一致；
- 确认私钥文件没有损坏；
- 确认安全组允许你的当前公网 IP 访问 22 端口；
- 阿里云若使用密钥对登录，请确认实例绑定的就是这把密钥；
- 不要在聊天中粘贴私钥内容。

### `Permission denied (publickey)` 与私钥权限

Windows OpenSSH 可能拒绝权限过宽的私钥。右键私钥 → 属性 → 安全 → 高级，移除继承权限，只给当前 Windows 用户读取权限。

---

## 11. 服务器上的文件位置

| 路径 | 用途 |
| --- | --- |
| `/var/www/yukang-site/current` | 当前官网版本 |
| `/var/www/yukang-site/releases/` | 历次发布版本 |
| `/etc/nginx/sites-available/yukang-site.conf` | Debian/Ubuntu 配置 |
| `/etc/nginx/sites-enabled/yukang-site.conf` | Debian/Ubuntu 启用链接 |
| `/etc/nginx/conf.d/yukang-site.conf` | RHEL 系配置 |
| `/var/log/nginx/yukang-site.access.log` | 访问日志 |
| `/var/log/nginx/yukang-site.error.log` | 错误日志 |

---

## 12. 最短上线清单

- [ ] ECS 公网 IPv4 已记录
- [ ] 域名已完成实名认证
- [ ] 中国大陆 ECS 已完成 ICP 备案
- [ ] 安全组放行 22（限制来源）、80、443
- [ ] DNS `@` A 记录指向 ECS
- [ ] 可选 DNS `www` A 记录指向 ECS
- [ ] SSH 私钥保存在 `D:\` 且可以登录
- [ ] 已提供证书通知邮箱
- [ ] 运行 `deploy.ps1`
- [ ] 浏览器验证 HTTPS 和移动端页面
- [ ] 确认诊所业务系统仍未暴露到公网