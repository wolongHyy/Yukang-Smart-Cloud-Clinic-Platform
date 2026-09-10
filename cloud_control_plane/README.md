# YuKang Control Plane

FastAPI + PostgreSQL control plane for clinics, edge devices, releases, aggregate metrics, authorized patient lookup, and audit metadata.

Patient-identifying data must never be stored in this service. Aggregate payloads reject patient-related keys.

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
