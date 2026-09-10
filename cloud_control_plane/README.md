# YuKang Control Plane

FastAPI + PostgreSQL control plane for clinics, edge devices, releases, aggregate metrics, authorized patient lookup, and audit metadata.

Patient-identifying data must never be stored in this service. Aggregate payloads reject patient-related keys.

## Management console

The control plane mounts the management console at `/admin`. It requires the platform API key and can optionally use the provisioning key for edge registration. Current modules include:

- Dashboard and aggregate metrics
- Organizations and clinics
- Edge devices and online status
- Releases and update jobs
- Authorized lookup requests
- Users and role metadata
- Audit events

The console and APIs are available as a preview. RBAC enforcement and member tokens are implemented; production rollout still requires formal mTLS certificates, signed update execution in the target environment, a full GPU-built knowledge package, and pilot acceptance.

## Member tokens and RBAC

Create a member in `/admin`, then use **生成令牌** to issue a one-time visible `X-User-Token`. The platform key remains a super-admin compatibility path. Roles are enforced server-side and scoped by organization and clinic.

## mTLS certificates

Generate a private CA outside the repository:

```powershell
D:\CodexEnvs\yukang-control\Scripts\python.exe scripts\generate_mtls_ca.py --output D:\YukangCerts --host control.example.com
D:\CodexEnvs\yukang-control\Scripts\python.exe scripts\verify_mtls_certificates.py --directory D:\YukangCerts --host control.example.com
```

Copy `server.crt`, `server.key`, and `ca.crt` into `nginx/certs/` on the deployment host. Never commit these files.

## Local tests

```powershell
$env:PYTHONPATH = (Resolve-Path .).Path
D:\CodexEnvs\yukang-control\Scripts\python.exe -m pytest -q tests
```

## Production

1. Copy `.env.example` to `.env` and replace all secrets.
2. Generate an Ed25519 release-signing key outside the repository.
3. Put the server certificate, private key, and CA certificate under `nginx/certs`.
4. Run `docker compose up -d --build`.

Edge nodes connect outbound to `/edge/v1/connect`; clinics do not need public IP addresses or inbound firewall rules.
## Edge configuration

```powershell
$env:YUKONG_CONTROL_URL = "https://control.example.com"
$env:YUKONG_EDGE_ID = "<registered edge id>"
$env:YUKONG_EDGE_TOKEN = "<one-time returned edge token>"
$env:YUKONG_CLINIC_ID = "<clinic id>"
$env:YUKONG_EDGE_CERT_PATH = "D:\YukangCerts\edge.crt"
$env:YUKONG_EDGE_KEY_PATH = "D:\YukangCerts\edge.key"
$env:YUKONG_EDGE_CA_PATH = "D:\YukangCerts\ca.crt"
```

The edge node opens an outbound WebSocket connection, reports heartbeats and daily aggregate metrics, and receives signed update jobs.
