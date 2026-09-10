from __future__ import annotations

import json
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from app.config import Settings
from app.main import create_app


@pytest.fixture()
def client(tmp_path: Path) -> TestClient:
    settings = Settings(
        environment="test",
        database_url=f"sqlite:///{tmp_path / 'control.db'}",
        platform_api_key="platform-test-key",
        provisioning_key="provision-test-key",
        require_mtls=False,
        redis_url=None,
        auto_create_schema=True,
    )
    with TestClient(create_app(settings)) as test_client:
        yield test_client


def platform_headers() -> dict[str, str]:
    return {"X-Platform-Key": "platform-test-key"}


def provision_headers() -> dict[str, str]:
    return {"X-Provisioning-Key": "provision-test-key"}


def create_org_clinic(client: TestClient) -> tuple[str, str]:
    org = client.post(
        "/api/v1/orgs",
        headers=platform_headers(),
        json={"name": "测试连锁", "code": "test-chain"},
    )
    assert org.status_code == 201, org.text
    org_id = org.json()["id"]

    clinic = client.post(
        "/api/v1/clinics",
        headers=platform_headers(),
        json={"org_id": org_id, "name": "一店", "code": "store-1"},
    )
    assert clinic.status_code == 201, clinic.text
    return org_id, clinic.json()["id"]


def register_edge(client: TestClient, clinic_id: str) -> dict:
    response = client.post(
        "/api/v1/edge/register",
        headers=provision_headers(),
        json={
            "clinic_id": clinic_id,
            "device_fingerprint": "device-001",
            "hostname": "clinic-pc",
            "version": "4.0.0",
        },
    )
    assert response.status_code == 201, response.text
    return response.json()


def test_mtls_required_when_enabled(tmp_path: Path) -> None:
    settings = Settings(
        environment="test",
        database_url=f"sqlite:///{tmp_path / 'mtls.db'}",
        platform_api_key="platform-test-key",
        provisioning_key="provision-test-key",
        require_mtls=True,
        redis_url=None,
        auto_create_schema=True,
    )
    with TestClient(create_app(settings)) as test_client:
        denied = test_client.post(
            "/api/v1/orgs",
            headers=platform_headers(),
            json={"name": "无证书组织", "code": "no-cert"},
        )
        assert denied.status_code == 401
        assert "mTLS" in denied.text

        allowed = test_client.post(
            "/api/v1/orgs",
            headers={**platform_headers(), "X-SSL-Client-Verify": "SUCCESS"},
            json={"name": "已认证组织", "code": "with-cert"},
        )
        assert allowed.status_code == 201, allowed.text


def test_health(client: TestClient) -> None:
    response = client.get("/health")
    assert response.status_code == 200
    assert response.json()["status"] == "ok"


def test_create_org_clinic_and_register_edge(client: TestClient) -> None:
    _, clinic_id = create_org_clinic(client)
    edge = register_edge(client, clinic_id)
    assert edge["edge_id"]
    assert edge["edge_token"]
    assert edge["control_plane_public_key"]


def test_aggregate_rejects_patient_fields(client: TestClient) -> None:
    _, clinic_id = create_org_clinic(client)
    edge = register_edge(client, clinic_id)
    response = client.post(
        "/api/v1/aggregates",
        headers={"X-Edge-Id": edge["edge_id"], "X-Edge-Token": edge["edge_token"]},
        json={
            "clinic_id": clinic_id,
            "period_start": "2026-09-09T00:00:00Z",
            "period_end": "2026-09-09T23:59:59Z",
            "idempotency_key": "agg-1",
            "metrics": {"visit_count": 3, "patient_name": "张三"},
        },
    )
    assert response.status_code == 422
    assert "patient" in response.text.lower()


def test_aggregate_is_idempotent(client: TestClient) -> None:
    _, clinic_id = create_org_clinic(client)
    edge = register_edge(client, clinic_id)
    headers = {"X-Edge-Id": edge["edge_id"], "X-Edge-Token": edge["edge_token"]}
    payload = {
        "clinic_id": clinic_id,
        "period_start": "2026-09-09T00:00:00Z",
        "period_end": "2026-09-09T23:59:59Z",
        "idempotency_key": "agg-idem-1",
        "metrics": {"visit_count": 3, "revenue": 128.5},
    }
    first = client.post("/api/v1/aggregates", headers=headers, json=payload)
    second = client.post("/api/v1/aggregates", headers=headers, json=payload)
    assert first.status_code == 201, first.text
    assert second.status_code == 200, second.text
    assert first.json()["id"] == second.json()["id"]


def test_release_signature_and_update_job(client: TestClient) -> None:
    org_id, clinic_id = create_org_clinic(client)
    edge = register_edge(client, clinic_id)
    release = client.post(
        "/api/v1/releases",
        headers=platform_headers(),
        json={
            "version": "4.1.0",
            "artifact_url": "https://downloads.example.com/yukang-4.1.0.zip",
            "sha256": "a" * 64,
            "min_version": "4.0.0",
        },
    )
    assert release.status_code == 201, release.text
    assert release.json()["signature"]

    job = client.post(
        "/api/v1/updates",
        headers=platform_headers(),
        json={
            "release_id": release.json()["id"],
            "edge_ids": [edge["edge_id"]],
            "idempotency_key": "update-1",
        },
    )
    assert job.status_code == 201, job.text
    assert job.json()["jobs"][0]["status"] == "pending"

    audit = client.get(f"/api/v1/audit?org_id={org_id}", headers=platform_headers())
    assert audit.status_code == 200, audit.text
    assert any(event["action"] == "update.queued" for event in audit.json())


def test_lookup_request_requires_source_clinic_approval(client: TestClient) -> None:
    org_id, clinic_id = create_org_clinic(client)
    request = client.post(
        "/api/v1/lookup-requests",
        headers=platform_headers(),
        json={
            "requester_org_id": org_id,
            "source_clinic_id": clinic_id,
            "match_token": "hmac-token-value",
            "reason": "患者复诊",
            "idempotency_key": "lookup-1",
        },
    )
    assert request.status_code == 201, request.text
    request_id = request.json()["id"]
    assert request.json()["status"] == "pending"

    approved = client.post(
        f"/api/v1/lookup-requests/{request_id}/approve",
        headers=platform_headers(),
        json={"approved_by": "owner-1", "ttl_seconds": 300},
    )
    assert approved.status_code == 200, approved.text
    assert approved.json()["status"] == "approved"
    assert approved.json()["expires_at"]


def test_websocket_edge_heartbeat(client: TestClient) -> None:
    _, clinic_id = create_org_clinic(client)
    edge = register_edge(client, clinic_id)
    with client.websocket_connect(
        f"/edge/v1/connect?edge_id={edge['edge_id']}&token={edge['edge_token']}"
    ) as websocket:
        welcome = websocket.receive_json()
        assert welcome["type"] == "hello_ack"
        websocket.send_json(
            {
                "type": "heartbeat",
                "edge_id": edge["edge_id"],
                "sent_at": "2026-09-10T10:00:00Z",
                "version": "4.0.0",
            }
        )
        ack = websocket.receive_json()
        assert ack["type"] == "heartbeat_ack"


def test_audit_log_contains_metadata_without_patient_text(client: TestClient) -> None:
    org_id, clinic_id = create_org_clinic(client)
    edge = register_edge(client, clinic_id)
    client.post(
        "/api/v1/aggregates",
        headers={"X-Edge-Id": edge["edge_id"], "X-Edge-Token": edge["edge_token"]},
        json={
            "clinic_id": clinic_id,
            "period_start": "2026-09-09T00:00:00Z",
            "period_end": "2026-09-09T23:59:59Z",
            "idempotency_key": "agg-audit-1",
            "metrics": {"visit_count": 1},
        },
    )
    audit = client.get(f"/api/v1/audit?org_id={org_id}", headers=platform_headers())
    assert audit.status_code == 200, audit.text
    body = json.dumps(audit.json(), ensure_ascii=False)
    assert "aggregate.received" in body
    assert "张三" not in body
    assert "chief_complaint" not in body
def test_websocket_receives_pending_update_job(client: TestClient) -> None:
    _, clinic_id = create_org_clinic(client)
    edge = register_edge(client, clinic_id)
    release = client.post(
        "/api/v1/releases",
        headers=platform_headers(),
        json={
            "version": "4.2.0",
            "artifact_url": "https://downloads.example.com/yukang-4.2.0.zip",
            "sha256": "b" * 64,
            "min_version": "4.0.0",
        },
    )
    assert release.status_code == 201, release.text

    with client.websocket_connect(
        f"/edge/v1/connect?edge_id={edge['edge_id']}&token={edge['edge_token']}"
    ) as websocket:
        assert websocket.receive_json()["type"] == "hello_ack"
        queued = client.post(
            "/api/v1/updates",
            headers=platform_headers(),
            json={
                "release_id": release.json()["id"],
                "edge_ids": [edge["edge_id"]],
                "idempotency_key": "update-websocket-1",
            },
        )
        assert queued.status_code == 201, queued.text
        offer = websocket.receive_json()
        assert offer["type"] == "job_offer"
        assert offer["release"]["version"] == "4.2.0"
def test_websocket_accepts_idempotent_aggregate_push(client: TestClient) -> None:
    _, clinic_id = create_org_clinic(client)
    edge = register_edge(client, clinic_id)
    payload = {
        "clinic_id": clinic_id,
        "period_start": "2026-09-09T00:00:00Z",
        "period_end": "2026-09-09T23:59:59Z",
        "idempotency_key": "ws-aggregate-1",
        "metrics": {"visit_count": 2, "revenue": 99.5},
    }
    with client.websocket_connect(
        f"/edge/v1/connect?edge_id={edge['edge_id']}&token={edge['edge_token']}"
    ) as websocket:
        assert websocket.receive_json()["type"] == "hello_ack"
        websocket.send_json({"type": "aggregate_push", "aggregate": payload})
        first = websocket.receive_json()
        assert first["type"] == "aggregate_ack"
        websocket.send_json({"type": "aggregate_push", "aggregate": payload})
        second = websocket.receive_json()
        assert second["type"] == "aggregate_ack"
        assert second["id"] == first["id"]
def test_aggregate_summary_returns_only_metrics(client: TestClient) -> None:
    org_id, clinic_id = create_org_clinic(client)
    edge = register_edge(client, clinic_id)
    headers = {"X-Edge-Id": edge["edge_id"], "X-Edge-Token": edge["edge_token"]}
    for index in (1, 2):
        response = client.post(
            "/api/v1/aggregates",
            headers=headers,
            json={
                "clinic_id": clinic_id,
                "period_start": f"2026-09-0{index}T00:00:00Z",
                "period_end": f"2026-09-0{index}T23:59:59Z",
                "idempotency_key": f"summary-{index}",
                "metrics": {"visit_count": index, "revenue": index * 10},
            },
        )
        assert response.status_code == 201, response.text

    summary = client.get(f"/api/v1/aggregates/summary?org_id={org_id}", headers=platform_headers())
    assert summary.status_code == 200, summary.text
    assert summary.json()["totals"]["visit_count"] == 3
    assert summary.json()["totals"]["revenue"] == 30
    assert "patient" not in str(summary.json()).lower()
