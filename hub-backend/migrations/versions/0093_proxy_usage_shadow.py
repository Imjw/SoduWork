"""Isolate model proxy observations from user billing and quota aggregates."""
from alembic import op
import sqlalchemy as sa

revision = "0093_proxy_usage_shadow"
down_revision = "0092_task_text_storage"
branch_labels = None
depends_on = None


def upgrade():
    op.create_table("proxy_usage_observation",
        sa.Column("id", sa.String(36), primary_key=True),
        sa.Column("recorded_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
        *(sa.Column(name, sa.String(size), nullable=False) for name, size in (
            ("client_id", 36), ("user_id", 36), ("agent", 240), ("provider", 240),
            ("model", 240), ("funding", 24), ("protocol", 24), ("outcome", 24),
            ("evidence", 24), ("provider_response_hash", 64))),
        sa.Column("counts", sa.JSON(), nullable=False))
    op.create_index("ix_proxy_usage_observation_recorded_at", "proxy_usage_observation", ["recorded_at"])


def downgrade():
    op.drop_table("proxy_usage_observation")
