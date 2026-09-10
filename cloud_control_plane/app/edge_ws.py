from __future__ import annotations

from datetime import datetime, timezone

from fastapi import APIRouter, WebSocket, WebSocketDisconnect
from sqlalchemy import select

from .models import AggregateSnapshot, Clinic, EdgeNode, Release, UpdateJob
from .schemas import AggregateCreate
from .security import token_hash
from .services.audit import record_audit

router = APIRouter()


@router.websocket("/edge/v1/connect")
async def edge_connect(websocket: WebSocket, edge_id: str, token: str) -> None:
    app = websocket.app
    settings = app.state.settings
    if settings.require_mtls and websocket.headers.get("X-SSL-Client-Verify", "").upper() != "SUCCESS":
        await websocket.close(code=4401)
        return

    with app.state.db.session() as session:
        edge = session.scalar(select(EdgeNode).where(EdgeNode.id == edge_id))
        if not edge or edge.status != "active" or edge.token_hash != token_hash(token):
            await websocket.close(code=4401)
            return
        edge.last_seen_at = datetime.now(timezone.utc)

    manager = app.state.connections
    await manager.connect(edge_id, websocket)
    try:
        await websocket.send_json(
            {
                "type": "hello_ack",
                "edge_id": edge_id,
                "server_time": datetime.now(timezone.utc).isoformat(),
                "heartbeat_interval_seconds": 300,
            }
        )
        with app.state.db.session() as session:
            pending = session.execute(
                select(UpdateJob, Release)
                .join(Release, UpdateJob.release_id == Release.id)
                .where(UpdateJob.edge_id == edge_id, UpdateJob.status == "pending")
            ).all()
            for job, release in pending:
                await websocket.send_json(
                    {
                        "type": "job_offer",
                        "job": {"id": job.id, "status": job.status, "attempts": job.attempts},
                        "release": {
                            "id": release.id,
                            "version": release.version,
                            "artifact_url": release.artifact_url,
                            "sha256": release.sha256,
                            "signature": release.signature,
                            "signing_public_key": release.signing_public_key,
                            "min_version": release.min_version,
                        },
                    }
                )
        while True:
            message = await websocket.receive_json()
            message_type = message.get("type")
            if message_type == "heartbeat":
                with app.state.db.session() as session:
                    edge = session.scalar(select(EdgeNode).where(EdgeNode.id == edge_id))
                    if edge:
                        edge.last_seen_at = datetime.now(timezone.utc)
                        edge.version = str(message.get("version") or edge.version)
                await websocket.send_json(
                    {
                        "type": "heartbeat_ack",
                        "server_time": datetime.now(timezone.utc).isoformat(),
                    }
                )
            elif message_type == "aggregate_push":
                try:
                    body = AggregateCreate.model_validate(message.get("aggregate") or {})
                    if body.clinic_id != edge_id and body.clinic_id != edge.clinic_id:
                        raise ValueError("aggregate clinic does not match edge")
                    with app.state.db.session() as session:
                        existing = session.query(AggregateSnapshot).filter_by(idempotency_key=body.idempotency_key).first()
                        if existing:
                            snapshot_id = existing.id
                        else:
                            clinic = session.get(Clinic, edge.clinic_id)
                            snapshot = AggregateSnapshot(
                                id=__import__("uuid").uuid4().hex,
                                clinic_id=edge.clinic_id,
                                edge_id=edge_id,
                                period_start=body.period_start,
                                period_end=body.period_end,
                                metrics=body.metrics,
                                idempotency_key=body.idempotency_key,
                            )
                            session.add(snapshot)
                            record_audit(
                                session,
                                action="aggregate.received",
                                actor_type="edge",
                                actor_id=edge_id,
                                resource_type="aggregate_snapshot",
                                resource_id=snapshot.id,
                                org_id=clinic.org_id if clinic else None,
                                clinic_id=edge.clinic_id,
                                details={"metric_keys": sorted(body.metrics.keys())},
                            )
                            snapshot_id = snapshot.id
                    await websocket.send_json({"type": "aggregate_ack", "id": snapshot_id})
                except Exception as exc:
                    await websocket.send_json({"type": "aggregate_error", "error": str(exc)})
            elif message_type == "job_result":
                job_id = str(message.get("job_id") or "")
                with app.state.db.session() as session:
                    job = session.scalar(select(UpdateJob).where(UpdateJob.id == job_id, UpdateJob.edge_id == edge_id))
                    if job:
                        job.status = str(message.get("status") or job.status)
                        job.failure_reason = str(message.get("failure_reason") or "")
                        job.attempts += 1
                await websocket.send_json({"type": "job_result_ack", "job_id": job_id})
            elif message_type == "policy_sync":
                await websocket.send_json({"type": "policy_sync_ack", "accepted": True})
            else:
                await websocket.send_json({"type": "error", "code": "UNKNOWN_MESSAGE_TYPE"})
    except WebSocketDisconnect:
        pass
    finally:
        manager.disconnect(edge_id, websocket)
