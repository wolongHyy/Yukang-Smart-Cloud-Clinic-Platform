from __future__ import annotations

from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    environment: str = "development"
    database_url: str = "sqlite:///./control_plane.db"
    platform_api_key: str = "change-me-platform"
    provisioning_key: str = "change-me-provision"
    redis_url: str | None = None
    require_mtls: bool = False
    auto_create_schema: bool = True
    edge_signing_private_key_pem: str | None = None
    edge_signing_public_key_pem: str | None = None

    model_config = SettingsConfigDict(
        env_file=".env",
        env_prefix="YUKANG_CP_",
        extra="ignore",
    )
