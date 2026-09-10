"""rbac user tokens

Revision ID: 20260910_rbac_user_tokens
Revises: 656bd67b04a6
Create Date: 2026-09-10
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = "20260910_rbac_user_tokens"
down_revision: Union[str, None] = "656bd67b04a6"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column("users", sa.Column("token_hash", sa.String(length=64), nullable=True))
    op.add_column("users", sa.Column("token_issued_at", sa.DateTime(timezone=True), nullable=True))
    op.create_index("ix_users_token_hash", "users", ["token_hash"], unique=True)


def downgrade() -> None:
    op.drop_index("ix_users_token_hash", table_name="users")
    op.drop_column("users", "token_issued_at")
    op.drop_column("users", "token_hash")
