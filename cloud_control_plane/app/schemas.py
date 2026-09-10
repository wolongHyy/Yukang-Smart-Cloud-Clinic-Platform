from __future__ import annotations

import re
from datetime import datetime
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field, field_validator


FORBIDDEN_AGGREGATE_KEYS = re.compile(
    r"(name|phone|mobile|idcard|identity|address|patient|chief|diagnosis|prescription|allergy|medical|病历|患者|姓名|手机|身份证)",
    re.IGNORECASE,
)


class StrictModel(BaseModel):
    model_config = ConfigDict(extra="forbid")


class OrganizationCreate(StrictModel):
    name: str = Field(min_length=2, max_length=120)
    code: str = Field(pattern=r"^[a-z0-9][a-z0-9-]{1,63}$")


class OrganizationRead(StrictModel):
    model_config = ConfigDict(from_attributes=True)
    id: str
    name: str
    code: str
    status: str
    created_at: datetime


class ClinicCreate(StrictModel):
    org_id: str
    name: str = Field(min_length=2, max_length=120)
    code: str = Field(pattern=r"^[a-zA-Z0-9_-]{1,64}$")
    address: str = Field(default="", max_length=255)


class ClinicRead(StrictModel):
    model_config = ConfigDict(from_attributes=True)
    id: str
    org_id: str
    name: str
    code: str
    address: str
    status: str
    created_at: datetime


Role = Literal["platform_admin", "org_owner", "store_manager", "doctor", "pharmacist", "finance", "auditor"]


class UserCreate(StrictModel):
    org_id: str
    clinic_id: str | None = None
    username: str = Field(min_length=2, max_length=80)
    display_name: str = Field(default="", max_length=120)
    role: Role


class UserRead(StrictModel):
    model_config = ConfigDict(from_attributes=True)
    id: str
    org_id: str
    clinic_id: str | None
    username: str
    display_name: str
    role: str
    status: str
    created_at: datetime


class UserTokenRead(StrictModel):
    user_id: str
    access_token: str
    issued_at: datetime


class EdgeRegisterRequest(StrictModel):
    clinic_id: str
    device_fingerprint: str = Field(min_length=4, max_length=128)
    hostname: str = Field(default="", max_length=120)
    version: str = Field(default="", max_length=32)


class EdgeRegisterResponse(StrictModel):
    edge_id: str
    edge_token: str
    control_plane_public_key: str


class AggregateCreate(StrictModel):
    clinic_id: str
    period_start: datetime
    period_end: datetime
    metrics: dict[str, float]
    idempotency_key: str = Field(min_length=8, max_length=128)

    @field_validator("metrics")
    @classmethod
    def reject_patient_fields(cls, value: dict[str, float]) -> dict[str, float]:
        if not value:
            raise ValueError("metrics must not be empty")
        for key in value:
            if FORBIDDEN_AGGREGATE_KEYS.search(key):
                raise ValueError(f"metrics contains patient-identifying field: {key}")
        return value


class AggregateRead(StrictModel):
    model_config = ConfigDict(from_attributes=True)
    id: str
    clinic_id: str
    edge_id: str
    period_start: datetime
    period_end: datetime
    metrics: dict[str, float]
    idempotency_key: str
    received_at: datetime


class ReleaseCreate(StrictModel):
    version: str = Field(pattern=r"^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$")
    artifact_url: str = Field(min_length=8, max_length=500)
    sha256: str = Field(pattern=r"^[a-fA-F0-9]{64}$")
    min_version: str = Field(default="0.0.0", pattern=r"^\d+\.\d+\.\d+$")


class ReleaseRead(StrictModel):
    model_config = ConfigDict(from_attributes=True)
    id: str
    version: str
    artifact_url: str
    sha256: str
    signature: str
    signing_public_key: str
    min_version: str
    status: str
    created_at: datetime


class UpdateCreate(StrictModel):
    release_id: str
    edge_ids: list[str] = Field(min_length=1, max_length=500)
    idempotency_key: str = Field(min_length=8, max_length=128)


class UpdateJobRead(StrictModel):
    model_config = ConfigDict(from_attributes=True)
    id: str
    release_id: str
    edge_id: str
    status: str
    attempts: int
    failure_reason: str
    idempotency_key: str
    created_at: datetime
    updated_at: datetime


class UpdateBatchRead(StrictModel):
    jobs: list[UpdateJobRead]


class LookupRequestCreate(StrictModel):
    requester_org_id: str
    requester_user_id: str | None = None
    source_clinic_id: str
    match_token: str = Field(min_length=16, max_length=128)
    reason: str = Field(min_length=2, max_length=255)
    idempotency_key: str = Field(min_length=8, max_length=128)


class LookupRequestRead(StrictModel):
    model_config = ConfigDict(from_attributes=True)
    id: str
    requester_org_id: str
    requester_user_id: str | None
    source_clinic_id: str
    match_token: str
    reason: str
    status: str
    approved_by: str | None
    approved_at: datetime | None
    expires_at: datetime | None
    idempotency_key: str
    created_at: datetime


class LookupApprove(StrictModel):
    approved_by: str = Field(min_length=1, max_length=80)
    ttl_seconds: int = Field(default=300, ge=30, le=3600)


class LookupDeny(StrictModel):
    denied_by: str = Field(min_length=1, max_length=80)
    reason: str = Field(default="", max_length=255)


class AuditRead(StrictModel):
    model_config = ConfigDict(from_attributes=True)
    id: str
    org_id: str | None
    clinic_id: str | None
    actor_type: str
    actor_id: str
    action: str
    resource_type: str
    resource_id: str
    details: dict
    created_at: datetime
