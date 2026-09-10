from __future__ import annotations

from datetime import datetime, timedelta, timezone
from uuid import uuid4

from fastapi import APIRouter, Depends, HTTPException, Request, Response, status
from sqlalchemy import desc, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from .config import Settings
from .models import (
    AggregateSnapshot,
    AuditEvent,
    Clinic,
    EdgeNode,
    LookupRequest,
    Organization,
    Release,
    UpdateJob,
    User,
)
from .schemas import (
    AggregateCreate,
    AggregateRead,
    AuditRead,
    ClinicCreate,
    ClinicRead,
    EdgeRegisterRequest,
    EdgeRegisterResponse,
    LookupApprove,
    LookupDeny,
    LookupRequestCreate,
    LookupRequestRead,
    OrganizationCreate,
    OrganizationRead,
    ReleaseCreate,
    ReleaseRead,
    UpdateBatchRead,
    UpdateCreate,
    UserCreate,
    UserRead,
    UserTokenRead,
)
from .security import (
    Principal,
    ensure_clinic_access,
    ensure_org_access,
    get_session,
    get_settings,
    issue_edge_token,
    issue_user_token,
    require_edge,
    require_permission,
    require_platform_key,
    require_provisioning_key,
    token_hash,
)
from .services.audit import record_audit

router = APIRouter()


def new_id() -> str:
    return uuid4().hex


def utcnow() -> datetime:
    return datetime.now(timezone.utc)


@router.get("/health")
def health(request: Request) -> dict:
    with request.app.state.db.session() as session:
        session.execute(select(1))
    return {
        "status": "ok",
        "service": "yukang-control-plane",
        "environment": request.app.state.settings.environment,
        "online_edges": len(request.app.state.connections.online_edges()),
    }


@router.post("/api/v1/orgs", response_model=OrganizationRead, status_code=201)
def create_org(
    body: OrganizationCreate,
    session: Session = Depends(get_session),
    principal: Principal = Depends(require_permission("orgs:write")),
):
    organization = Organization(id=new_id(), name=body.name, code=body.code, status="active")
    session.add(organization)
    record_audit(
        session,
        action="org.created",
        actor_type="platform_admin",
        actor_id="platform",
        resource_type="organization",
        resource_id=organization.id,
        org_id=organization.id,
        details={"code": organization.code},
    )
    try:
        session.flush()
    except IntegrityError as exc:
        raise HTTPException(status_code=409, detail="organization code already exists") from exc
    return organization


@router.get("/api/v1/orgs", response_model=list[OrganizationRead])
def list_orgs(
    session: Session = Depends(get_session),
    principal: Principal = Depends(require_permission("orgs:read")),
):
    query = select(Organization)
    if not principal.is_platform_admin:
        query = query.where(Organization.id == principal.org_id)
    return session.scalars(query.order_by(Organization.created_at)).all()


@router.get("/api/v1/orgs/{org_id}", response_model=OrganizationRead)
def get_org(
    org_id: str,
    session: Session = Depends(get_session),
    principal: Principal = Depends(require_permission("orgs:read")),
):
    organization = session.get(Organization, org_id)
    if not organization:
        raise HTTPException(status_code=404, detail="organization not found")
    ensure_org_access(principal, organization.id)
    return organization


@router.post("/api/v1/clinics", response_model=ClinicRead, status_code=201)
def create_clinic(
    body: ClinicCreate,
    session: Session = Depends(get_session),
    principal: Principal = Depends(require_permission("clinics:write")),
):
    if not session.get(Organization, body.org_id):
        raise HTTPException(status_code=404, detail="organization not found")
    ensure_org_access(principal, body.org_id)
    clinic = Clinic(
        id=new_id(),
        org_id=body.org_id,
        name=body.name,
        code=body.code,
        address=body.address,
        status="active",
    )
    session.add(clinic)
    record_audit(
        session,
        action="clinic.created",
        actor_type="platform_admin",
        actor_id="platform",
        resource_type="clinic",
        resource_id=clinic.id,
        org_id=clinic.org_id,
        clinic_id=clinic.id,
        details={"code": clinic.code},
    )
    try:
        session.flush()
    except IntegrityError as exc:
        raise HTTPException(status_code=409, detail="clinic code already exists") from exc
    return clinic


@router.get("/api/v1/clinics", response_model=list[ClinicRead])
def list_clinics(
    org_id: str | None = None,
    session: Session = Depends(get_session),
    principal: Principal = Depends(require_permission("clinics:read")),
):
    query = select(Clinic)
    if org_id:
        ensure_org_access(principal, org_id)
        query = query.where(Clinic.org_id == org_id)
    if not principal.is_platform_admin:
        query = query.where(Clinic.org_id == principal.org_id)
        if principal.clinic_id:
            query = query.where(Clinic.id == principal.clinic_id)
    return session.scalars(query.order_by(Clinic.created_at)).all()


@router.post("/api/v1/users", response_model=UserRead, status_code=201)
def create_user(
    body: UserCreate,
    session: Session = Depends(get_session),
    principal: Principal = Depends(require_permission("users:write")),
):
    if not session.get(Organization, body.org_id):
        raise HTTPException(status_code=404, detail="organization not found")
    ensure_org_access(principal, body.org_id)
    if body.clinic_id:
        clinic = session.get(Clinic, body.clinic_id)
        if not clinic or clinic.org_id != body.org_id:
            raise HTTPException(status_code=404, detail="clinic not found")
        ensure_clinic_access(principal, body.clinic_id)
    if not principal.is_platform_admin and body.role == "platform_admin":
        raise HTTPException(status_code=403, detail="platform administrator role requires platform access")
    user = User(
        id=new_id(),
        org_id=body.org_id,
        clinic_id=body.clinic_id,
        username=body.username,
        display_name=body.display_name,
        role=body.role,
        status="active",
    )
    session.add(user)
    record_audit(
        session,
        action="user.created",
        actor_type="platform_admin",
        actor_id="platform",
        resource_type="user",
        resource_id=user.id,
        org_id=user.org_id,
        clinic_id=user.clinic_id,
        details={"role": user.role},
    )
    try:
        session.flush()
    except IntegrityError as exc:
        raise HTTPException(status_code=409, detail="username already exists in organization") from exc
    return user


@router.post("/api/v1/users/{user_id}/token", response_model=UserTokenRead)
def rotate_user_token(
    user_id: str,
    session: Session = Depends(get_session),
    principal: Principal = Depends(require_permission("users:write")),
):
    user = session.get(User, user_id)
    if not user:
        raise HTTPException(status_code=404, detail="user not found")
    ensure_org_access(principal, user.org_id)
    if user.clinic_id:
        ensure_clinic_access(principal, user.clinic_id)
    if not principal.is_platform_admin and user.role == "platform_admin":
        raise HTTPException(status_code=403, detail="cannot rotate platform administrator token")
    token = issue_user_token()
    user.token_hash = token_hash(token)
    user.token_issued_at = utcnow()
    record_audit(
        session,
        action="user.token_rotated",
        actor_type="platform_admin" if principal.is_platform_admin else "user",
        actor_id=principal.user_id or "platform",
        resource_type="user",
        resource_id=user.id,
        org_id=user.org_id,
        clinic_id=user.clinic_id,
        details={"role": user.role},
    )
    session.flush()
    return UserTokenRead(user_id=user.id, access_token=token, issued_at=user.token_issued_at)


@router.post("/api/v1/edge/register", response_model=EdgeRegisterResponse)
def register_edge(
    body: EdgeRegisterRequest,
    response: Response,
    request: Request,
    session: Session = Depends(get_session),
    _: None = Depends(require_provisioning_key),
):
    clinic = session.get(Clinic, body.clinic_id)
    if not clinic or clinic.status != "active":
        raise HTTPException(status_code=404, detail="active clinic not found")
    token = issue_edge_token()
    edge = session.scalar(
        select(EdgeNode).where(
            EdgeNode.clinic_id == body.clinic_id,
            EdgeNode.device_fingerprint == body.device_fingerprint,
        )
    )
    if edge:
        edge.hostname = body.hostname
        edge.version = body.version
        edge.token_hash = token_hash(token)
        edge.status = "active"
        response.status_code = status.HTTP_200_OK
    else:
        edge = EdgeNode(
            id=new_id(),
            clinic_id=body.clinic_id,
            device_fingerprint=body.device_fingerprint,
            hostname=body.hostname,
            version=body.version,
            token_hash=token_hash(token),
            status="active",
        )
        session.add(edge)
        response.status_code = status.HTTP_201_CREATED
    record_audit(
        session,
        action="edge.registered",
        actor_type="provisioning",
        actor_id="provisioning-key",
        resource_type="edge",
        resource_id=edge.id,
        org_id=clinic.org_id,
        clinic_id=clinic.id,
        details={"hostname": edge.hostname, "version": edge.version},
    )
    session.flush()
    return EdgeRegisterResponse(
        edge_id=edge.id,
        edge_token=token,
        control_plane_public_key=request.app.state.signing.public_key_pem(),
    )


@router.post("/api/v1/releases", response_model=ReleaseRead, status_code=201)
def create_release(
    body: ReleaseCreate,
    request: Request,
    session: Session = Depends(get_session),
    principal: Principal = Depends(require_permission("releases:write")),
):
    manifest = {
        "version": body.version,
        "artifact_url": body.artifact_url,
        "sha256": body.sha256.lower(),
        "min_version": body.min_version,
    }
    signature = request.app.state.signing.sign_manifest(manifest)
    release = Release(
        id=new_id(),
        version=body.version,
        artifact_url=body.artifact_url,
        sha256=body.sha256.lower(),
        signature=signature,
        signing_public_key=request.app.state.signing.public_key_pem(),
        min_version=body.min_version,
        status="published",
    )
    session.add(release)
    record_audit(
        session,
        action="release.published",
        actor_type="platform_admin",
        actor_id="platform",
        resource_type="release",
        resource_id=release.id,
        details={"version": release.version, "sha256": release.sha256},
    )
    try:
        session.flush()
    except IntegrityError as exc:
        raise HTTPException(status_code=409, detail="release version already exists") from exc
    return release


@router.get("/api/v1/releases", response_model=list[ReleaseRead])
def list_releases(
    session: Session = Depends(get_session),
    principal: Principal = Depends(require_permission("releases:read")),
):
    return session.scalars(select(Release).order_by(desc(Release.created_at))).all()


@router.post("/api/v1/updates", response_model=UpdateBatchRead)
async def create_updates(
    body: UpdateCreate,
    response: Response,
    request: Request,
    session: Session = Depends(get_session),
    principal: Principal = Depends(require_permission("updates:write")),
):
    release = session.get(Release, body.release_id)
    if not release:
        raise HTTPException(status_code=404, detail="release not found")
    existing = session.scalars(
        select(UpdateJob).where(UpdateJob.idempotency_key == body.idempotency_key)
    ).all()
    if existing:
        response.status_code = status.HTTP_200_OK
        return UpdateBatchRead(jobs=existing)

    jobs: list[UpdateJob] = []
    for edge_id in body.edge_ids:
        edge = session.get(EdgeNode, edge_id)
        if not edge or edge.status != "active":
            raise HTTPException(status_code=404, detail=f"active edge not found: {edge_id}")
        job = UpdateJob(
            id=new_id(),
            release_id=release.id,
            edge_id=edge.id,
            status="pending",
            attempts=0,
            failure_reason="",
            idempotency_key=body.idempotency_key,
        )
        session.add(job)
        jobs.append(job)
        record_audit(
            session,
            action="update.queued",
            actor_type="platform_admin",
            actor_id="platform",
            resource_type="update_job",
            resource_id=job.id,
            org_id=session.get(Clinic, edge.clinic_id).org_id,
            clinic_id=edge.clinic_id,
            details={"version": release.version, "edge_id": edge.id},
        )
    session.flush()
    for job in jobs:
        await request.app.state.connections.send(
            job.edge_id,
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
            },
        )
    response.status_code = status.HTTP_201_CREATED
    return UpdateBatchRead(jobs=jobs)


@router.get("/api/v1/updates", response_model=list[dict])
def list_updates(
    edge_id: str | None = None,
    session: Session = Depends(get_session),
    principal: Principal = Depends(require_permission("updates:read")),
):
    query = (
        select(UpdateJob, Release)
        .join(Release, UpdateJob.release_id == Release.id)
        .join(EdgeNode, EdgeNode.id == UpdateJob.edge_id)
        .join(Clinic, Clinic.id == EdgeNode.clinic_id)
    )
    if edge_id:
        query = query.where(UpdateJob.edge_id == edge_id)
    if not principal.is_platform_admin:
        query = query.where(Clinic.org_id == principal.org_id)
        if principal.clinic_id:
            query = query.where(EdgeNode.clinic_id == principal.clinic_id)
    rows = session.execute(query.order_by(desc(UpdateJob.created_at))).all()
    return [
        {
            "id": job.id,
            "edge_id": job.edge_id,
            "status": job.status,
            "attempts": job.attempts,
            "failure_reason": job.failure_reason,
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
        for job, release in rows
    ]


@router.post("/api/v1/aggregates", response_model=AggregateRead)
def receive_aggregate(
    body: AggregateCreate,
    response: Response,
    edge: EdgeNode = Depends(require_edge),
    session: Session = Depends(get_session),
):
    if edge.clinic_id != body.clinic_id:
        raise HTTPException(status_code=403, detail="edge may only submit data for its clinic")
    existing = session.scalar(
        select(AggregateSnapshot).where(AggregateSnapshot.idempotency_key == body.idempotency_key)
    )
    if existing:
        if existing.edge_id != edge.id or existing.clinic_id != body.clinic_id:
            raise HTTPException(status_code=409, detail="idempotency key already used")
        response.status_code = status.HTTP_200_OK
        return existing
    if body.period_end < body.period_start:
        raise HTTPException(status_code=422, detail="period_end must be after period_start")
    snapshot = AggregateSnapshot(
        id=new_id(),
        clinic_id=body.clinic_id,
        edge_id=edge.id,
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
        actor_id=edge.id,
        resource_type="aggregate_snapshot",
        resource_id=snapshot.id,
        org_id=session.get(Clinic, edge.clinic_id).org_id,
        clinic_id=edge.clinic_id,
        details={"metric_keys": sorted(body.metrics.keys())},
    )
    session.flush()
    response.status_code = status.HTTP_201_CREATED
    return snapshot


@router.get("/api/v1/aggregates/summary")
def aggregate_summary(
    org_id: str,
    clinic_id: str | None = None,
    start: datetime | None = None,
    end: datetime | None = None,
    session: Session = Depends(get_session),
    principal: Principal = Depends(require_permission("aggregates:read")),
):
    ensure_org_access(principal, org_id)
    effective_clinic_id = clinic_id or principal.clinic_id
    if effective_clinic_id:
        ensure_clinic_access(principal, effective_clinic_id)
    query = (
        select(AggregateSnapshot, Clinic)
        .join(Clinic, AggregateSnapshot.clinic_id == Clinic.id)
        .where(Clinic.org_id == org_id)
    )
    if effective_clinic_id:
        query = query.where(AggregateSnapshot.clinic_id == effective_clinic_id)
    if start:
        query = query.where(AggregateSnapshot.period_end >= start)
    if end:
        query = query.where(AggregateSnapshot.period_start <= end)
    rows = session.execute(query.order_by(AggregateSnapshot.period_end)).all()
    totals: dict[str, float] = {}
    clinics: dict[str, dict] = {}
    for snapshot, clinic in rows:
        clinic_summary = clinics.setdefault(clinic.id, {"clinic_id": clinic.id, "clinic_name": clinic.name, "metrics": {}})
        for key, value in snapshot.metrics.items():
            numeric = float(value)
            totals[key] = totals.get(key, 0.0) + numeric
            clinic_summary["metrics"][key] = clinic_summary["metrics"].get(key, 0.0) + numeric
    return {"org_id": org_id, "totals": totals, "clinics": list(clinics.values()), "snapshots": len(rows)}


@router.post("/api/v1/lookup-requests", response_model=LookupRequestRead, status_code=201)
def create_lookup_request(
    body: LookupRequestCreate,
    session: Session = Depends(get_session),
    principal: Principal = Depends(require_permission("lookups:create")),
):
    ensure_org_access(principal, body.requester_org_id)
    source = session.get(Clinic, body.source_clinic_id)
    if not source:
        raise HTTPException(status_code=404, detail="source clinic not found")
    existing = session.scalar(
        select(LookupRequest).where(LookupRequest.idempotency_key == body.idempotency_key)
    )
    if existing:
        return existing
    lookup = LookupRequest(
        id=new_id(),
        requester_org_id=body.requester_org_id,
        requester_user_id=body.requester_user_id,
        source_clinic_id=body.source_clinic_id,
        match_token=body.match_token,
        reason=body.reason,
        status="pending",
        idempotency_key=body.idempotency_key,
    )
    session.add(lookup)
    record_audit(
        session,
        action="lookup.requested",
        actor_type="user",
        actor_id=body.requester_user_id or "unknown",
        resource_type="lookup_request",
        resource_id=lookup.id,
        org_id=body.requester_org_id,
        clinic_id=body.source_clinic_id,
        details={"reason": body.reason},
    )
    session.flush()
    return lookup


@router.get("/api/v1/lookup-requests", response_model=list[LookupRequestRead])
def list_lookup_requests(
    source_clinic_id: str | None = None,
    session: Session = Depends(get_session),
    principal: Principal = Depends(require_permission("lookups:read")),
):
    query = select(LookupRequest).join(Clinic, Clinic.id == LookupRequest.source_clinic_id)
    if source_clinic_id:
        ensure_clinic_access(principal, source_clinic_id)
        query = query.where(LookupRequest.source_clinic_id == source_clinic_id)
    if not principal.is_platform_admin:
        query = query.where(
            (LookupRequest.requester_org_id == principal.org_id) | (Clinic.org_id == principal.org_id)
        )
        if principal.clinic_id:
            query = query.where(
                (LookupRequest.requester_org_id == principal.org_id) | (LookupRequest.source_clinic_id == principal.clinic_id)
            )
    return session.scalars(query.order_by(desc(LookupRequest.created_at))).all()


@router.post("/api/v1/lookup-requests/{request_id}/approve", response_model=LookupRequestRead)
def approve_lookup_request(
    request_id: str,
    body: LookupApprove,
    session: Session = Depends(get_session),
    principal: Principal = Depends(require_permission("lookups:approve")),
):
    lookup = session.get(LookupRequest, request_id)
    if not lookup:
        raise HTTPException(status_code=404, detail="lookup request not found")
    source_clinic = session.get(Clinic, lookup.source_clinic_id)
    if not source_clinic:
        raise HTTPException(status_code=404, detail="source clinic not found")
    ensure_org_access(principal, source_clinic.org_id)
    ensure_clinic_access(principal, lookup.source_clinic_id)
    source_clinic = session.get(Clinic, lookup.source_clinic_id)
    if not source_clinic:
        raise HTTPException(status_code=404, detail="source clinic not found")
    ensure_org_access(principal, source_clinic.org_id)
    ensure_clinic_access(principal, lookup.source_clinic_id)
    if lookup.status != "pending":
        raise HTTPException(status_code=409, detail="lookup request is not pending")
    lookup.status = "approved"
    lookup.approved_by = body.approved_by
    lookup.approved_at = utcnow()
    lookup.expires_at = lookup.approved_at + timedelta(seconds=body.ttl_seconds)
    record_audit(
        session,
        action="lookup.approved",
        actor_type="source_clinic",
        actor_id=body.approved_by,
        resource_type="lookup_request",
        resource_id=lookup.id,
        clinic_id=lookup.source_clinic_id,
        details={"ttl_seconds": body.ttl_seconds},
    )
    session.flush()
    return lookup


@router.post("/api/v1/lookup-requests/{request_id}/deny", response_model=LookupRequestRead)
def deny_lookup_request(
    request_id: str,
    body: LookupDeny,
    session: Session = Depends(get_session),
    principal: Principal = Depends(require_permission("lookups:approve")),
):
    lookup = session.get(LookupRequest, request_id)
    if not lookup:
        raise HTTPException(status_code=404, detail="lookup request not found")
    if lookup.status != "pending":
        raise HTTPException(status_code=409, detail="lookup request is not pending")
    lookup.status = "denied"
    lookup.approved_by = body.denied_by
    lookup.approved_at = utcnow()
    record_audit(
        session,
        action="lookup.denied",
        actor_type="source_clinic",
        actor_id=body.denied_by,
        resource_type="lookup_request",
        resource_id=lookup.id,
        clinic_id=lookup.source_clinic_id,
        details={"reason": body.reason},
    )
    session.flush()
    return lookup


@router.get("/api/v1/audit", response_model=list[AuditRead])
def list_audit(
    org_id: str | None = None,
    clinic_id: str | None = None,
    limit: int = 100,
    session: Session = Depends(get_session),
    principal: Principal = Depends(require_permission("audit:read")),
):
    query = select(AuditEvent)
    if org_id:
        ensure_org_access(principal, org_id)
        query = query.where(AuditEvent.org_id == org_id)
    if clinic_id:
        ensure_clinic_access(principal, clinic_id)
        query = query.where(AuditEvent.clinic_id == clinic_id)
    if not principal.is_platform_admin:
        query = query.where(AuditEvent.org_id == principal.org_id)
        if principal.clinic_id:
            query = query.where(AuditEvent.clinic_id == principal.clinic_id)
    return session.scalars(query.order_by(desc(AuditEvent.created_at)).limit(min(max(limit, 1), 500))).all()


@router.get("/api/v1/users", response_model=list[UserRead])
def list_users(
    org_id: str | None = None,
    clinic_id: str | None = None,
    session: Session = Depends(get_session),
    principal: Principal = Depends(require_permission("users:read")),
):
    query = select(User)
    if org_id:
        ensure_org_access(principal, org_id)
        query = query.where(User.org_id == org_id)
    if clinic_id:
        ensure_clinic_access(principal, clinic_id)
        query = query.where(User.clinic_id == clinic_id)
    if not principal.is_platform_admin:
        query = query.where(User.org_id == principal.org_id)
        if principal.clinic_id:
            query = query.where(User.clinic_id == principal.clinic_id)
    return session.scalars(query.order_by(User.created_at)).all()


@router.get("/api/v1/edge/nodes")
def list_edge_nodes(
    org_id: str | None = None,
    clinic_id: str | None = None,
    session: Session = Depends(get_session),
    principal: Principal = Depends(require_permission("edges:read")),
):
    query = select(EdgeNode, Clinic).join(Clinic, EdgeNode.clinic_id == Clinic.id)
    if org_id:
        ensure_org_access(principal, org_id)
        query = query.where(Clinic.org_id == org_id)
    if clinic_id:
        ensure_clinic_access(principal, clinic_id)
        query = query.where(EdgeNode.clinic_id == clinic_id)
    if not principal.is_platform_admin:
        query = query.where(Clinic.org_id == principal.org_id)
        if principal.clinic_id:
            query = query.where(EdgeNode.clinic_id == principal.clinic_id)
    rows = session.execute(query.order_by(EdgeNode.created_at)).all()
    return [
        {
            "id": edge.id,
            "clinic_id": edge.clinic_id,
            "clinic_name": clinic.name,
            "org_id": clinic.org_id,
            "hostname": edge.hostname,
            "version": edge.version,
            "status": edge.status,
            "last_seen_at": edge.last_seen_at,
        }
        for edge, clinic in rows
    ]


@router.get("/api/v1/dashboard/summary")
def dashboard_summary(
    org_id: str | None = None,
    session: Session = Depends(get_session),
    principal: Principal = Depends(require_permission("dashboard:read")),
):
    effective_org_id = org_id or principal.org_id
    if effective_org_id:
        ensure_org_access(principal, effective_org_id)
    clinic_query = select(Clinic)
    edge_query = select(EdgeNode, Clinic).join(Clinic, EdgeNode.clinic_id == Clinic.id)
    lookup_query = select(LookupRequest)
    if effective_org_id:
        clinic_query = clinic_query.where(Clinic.org_id == effective_org_id)
        edge_query = edge_query.where(Clinic.org_id == effective_org_id)
        lookup_query = lookup_query.where(LookupRequest.requester_org_id == effective_org_id)
    if principal.clinic_id:
        clinic_query = clinic_query.where(Clinic.id == principal.clinic_id)
        edge_query = edge_query.where(EdgeNode.clinic_id == principal.clinic_id)
        lookup_query = lookup_query.where(LookupRequest.source_clinic_id == principal.clinic_id)
    clinics = session.scalars(clinic_query).all()
    edges = session.execute(edge_query).all()
    pending_lookups = session.scalars(lookup_query.where(LookupRequest.status == "pending")).all()
    scoped_edge_ids = [edge.id for edge, _clinic in edges]
    pending_updates = 0
    if scoped_edge_ids:
        pending_updates = session.query(UpdateJob).filter(
            UpdateJob.status == "pending",
            UpdateJob.edge_id.in_(scoped_edge_ids),
        ).count()
    return {
        "organizations": 1 if effective_org_id else session.query(Organization).count(),
        "clinics": len(clinics),
        "active_edges": sum(1 for edge, _clinic in edges if edge.status == "active"),
        "online_edges": sum(1 for edge, _clinic in edges if edge.last_seen_at is not None),
        "releases": session.query(Release).count() if principal.is_platform_admin else 0,
        "pending_updates": pending_updates,
        "pending_lookups": len(pending_lookups),
    }
