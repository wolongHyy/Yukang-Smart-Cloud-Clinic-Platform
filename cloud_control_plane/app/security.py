from __future__ import annotations

import hashlib
import secrets

from fastapi import Depends, Header, HTTPException, Request, status
from sqlalchemy import select
from sqlalchemy.orm import Session

from .config import Settings
from .models import EdgeNode


def get_settings(request: Request) -> Settings:
    return request.app.state.settings


def get_session(request: Request):
    with request.app.state.db.session() as session:
        yield session


def token_hash(token: str) -> str:
    return hashlib.sha256(token.encode("utf-8")).hexdigest()


def issue_edge_token() -> str:
    return secrets.token_urlsafe(32)


def assert_mtls(request: Request, settings: Settings) -> None:
    if not settings.require_mtls:
        return
    if request.headers.get("X-SSL-Client-Verify", "").upper() != "SUCCESS":
        raise HTTPException(status_code=401, detail="mTLS client certificate required")


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
