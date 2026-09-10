from __future__ import annotations

from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import FastAPI
from fastapi.staticfiles import StaticFiles
from fastapi.middleware.cors import CORSMiddleware

from .api import router as api_router
from .config import Settings
from .database import Database
from .edge_ws import router as edge_router
from .services.connections import ConnectionManager
from .services.signing import SigningService


@asynccontextmanager
async def lifespan(app: FastAPI):
    if app.state.settings.auto_create_schema:
        app.state.db.create_all()
    yield
    app.state.db.dispose()


def create_app(settings: Settings | None = None) -> FastAPI:
    settings = settings or Settings()
    app = FastAPI(
        title="YuKang Control Plane",
        version="0.1.0",
        lifespan=lifespan,
    )
    app.state.settings = settings
    app.state.db = Database(settings.database_url)
    app.state.connections = ConnectionManager()
    app.state.signing = SigningService(
        private_key_pem=settings.edge_signing_private_key_pem,
        public_key_pem=settings.edge_signing_public_key_pem,
    )
    app.add_middleware(
        CORSMiddleware,
        allow_origins=[],
        allow_credentials=False,
        allow_methods=["GET", "POST"],
        allow_headers=["Content-Type", "X-Platform-Key", "X-Provisioning-Key", "X-Edge-Id", "X-Edge-Token"],
    )
    app.include_router(api_router)
    app.include_router(edge_router)
    admin_dir = Path(__file__).resolve().parent.parent / 'admin'
    app.mount('/admin', StaticFiles(directory=admin_dir, html=True), name='admin')
    return app


app = create_app()
