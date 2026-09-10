from __future__ import annotations

import hashlib
import secrets
from dataclasses import dataclass

from fastapi import Depends, Header, HTTPException, Request, status
from sqlalchemy import select
from sqlalchemy.orm import Session

from .config import Settings
from .models import EdgeNode, User


ALL_PERMISSIONS = frozenset({
    "orgs:read", "orgs:write",
    "clinics:read", "clinics:write",
    "users:read", "users:write",
    "edges:read",
    "releases:read", "releases:write",
    "updates:read", "updates:write",
    "aggregates:read",
    "lookups:read", "lookups:create", "lookups:approve",
    "audit:read", "dashboard:read",
})

ROLE_PERMISSIONS = {
    "platform_admin": ALL_PERMISSIONS,
    "org_owner": frozenset({
        "orgs:read", "clinics:read", "clinics:write", "users:read", "users:write",
        "edges:read", "releases:read", "updates:read", "aggregates:read",
        "lookups:read", "lookups:create", "lookups:approve", "audit:read", "dashboard:read",
    }),
    "store_manager": frozenset({
        "clinics:read", "edges:read", "aggregates:read", "lookups:read",
        "lookups:create", "lookups:approve", "dashboard:read",
    }),
    "doctor": frozenset({"clinics:read", "aggregates:read", "lookups:read", "lookups:create", "dashboard:read"}),
    "pharmacist": frozenset({"clinics:read", "aggregates:read", "dashboard:read"}),
    "finance": frozenset({"aggregates:read", "dashboard:read"}),
    "auditor": frozenset({
        "orgs:read", "clinics:read", "edges:read", "releases:read", "updates:read",
        "aggregates:read", "lookups:read", "audit:read", "dashboard:read",
    }),
}


@dataclass(frozen=True)
class Principal:
    kind: str
    role: str
    org_id: str | None = None
    clinic_id: str | None = None
    user_id: str | None = None

    @property
    def is_platform_admin(self) -> bool:
        return self.kind == "platform"


def get_settings(request: Request) -> Settings:
    return request.app.state.settings


def get_session(request: Request):
    with request.app.state.db.session() as session:
        yield session


def token_hash(token: str) -> str:
    return hashlib.sha256(token.encode("utf-8")).hexdigest()


def issue_edge_token() -> str:
    return secrets.token_urlsafe(32)


def issue_user_token() -> str:
    return secrets.token_urlsafe(32)


def assert_mtls(request: Request, settings: Settings) -> None:
    if not settings.require_mtls:
        return
    if request.headers.get("X-SSL-Client-Verify", "").upper() != "SUCCESS":
        raise HTTPException(status_code=401, detail="mTLS client certificate required")


def ensure_org_access(principal: Principal, org_id: str) -> None:
    if principal.is_platform_admin:
        return
    if principal.org_id != org_id:
        raise HTTPException(status_code=403, detail="organization access denied")


def ensure_clinic_access(principal: Principal, clinic_id: str) -> None:
    if principal.is_platform_admin:
        return
    if principal.clinic_id and principal.clinic_id != clinic_id:
        raise HTTPException(status_code=403, detail="clinic access denied")


def require_platform_key(
    request: Request,
    x_platform_key: str | None = Header(default=None),
    settings: Settings = Depends(get_settings),
) -> None:
    assert_mtls(request, settings)
    if not x_platform_key or not secrets.compare_digest(x_platform_key, settings.platform_api_key):
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="invalid platform key")


def require_provisioning_key(
    request: Request,
    x_provisioning_key: str | None = Header(default=None),
    settings: Settings = Depends(get_settings),
) -> None:
    assert_mtls(request, settings)
    if not x_provisioning_key or not secrets.compare_digest(x_provisioning_key, settings.provisioning_key):
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="invalid provisioning key")


def require_permission(permission: str):
    def dependency(
        request: Request,
        x_platform_key: str | None = Header(default=None),
        x_user_token: str | None = Header(default=None),
        session: Session = Depends(get_session),
        settings: Settings = Depends(get_settings),
    ) -> Principal:
        assert_mtls(request, settings)
        if x_platform_key and secrets.compare_digest(x_platform_key, settings.platform_api_key):
            return Principal(kind="platform", role="platform_admin")

        if x_user_token:
            user = session.scalar(
                select(User).where(
                    User.token_hash == token_hash(x_user_token),
                    User.status == "active",
                )
            )
            if not user:
                raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="invalid member token")
            if permission not in ROLE_PERMISSIONS.get(user.role, frozenset()):
                raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="permission denied")
            return Principal(kind="user", role=user.role, org_id=user.org_id, clinic_id=user.clinic_id, user_id=user.id)

        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="platform key or member token required")

    return dependency


def authenticate_edge(
    request: Request,
    session: Session,
    edge_id: str,
    token: str,
    settings: Settings,
) -> EdgeNode:
    assert_mtls(request, settings)
    edge = session.scalar(select(EdgeNode).where(EdgeNode.id == edge_id))
    if not edge or edge.status != "active" or edge.token_hash != token_hash(token):
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="invalid edge credentials")
    return edge


def require_edge(
    request: Request,
    x_edge_id: str | None = Header(default=None),
    x_edge_token: str | None = Header(default=None),
    session: Session = Depends(get_session),
    settings: Settings = Depends(get_settings),
) -> EdgeNode:
    if not x_edge_id or not x_edge_token:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="edge credentials required")
    return authenticate_edge(request, session, x_edge_id, x_edge_token, settings)
