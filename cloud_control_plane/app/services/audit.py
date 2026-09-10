from __future__ import annotations

from typing import Any

from sqlalchemy.orm import Session

from ..models import AuditEvent, utcnow


def record_audit(
    session: Session,
    *,
    action: str,
    actor_type: str,
    actor_id: str,
    resource_type: str,
    resource_id: str = "",
    org_id: str | None = None,
    clinic_id: str | None = None,
    details: dict[str, Any] | None = None,
) -> AuditEvent:
    event = AuditEvent(
        id=__import__("uuid").uuid4().hex,
        org_id=org_id,
        clinic_id=clinic_id,
        actor_type=actor_type,
        actor_id=actor_id,
        action=action,
        resource_type=resource_type,
        resource_id=resource_id,
        details=details or {},
        created_at=utcnow(),
    )
    session.add(event)
    return event
