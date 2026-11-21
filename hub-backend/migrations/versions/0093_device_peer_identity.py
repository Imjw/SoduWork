"""Bind direct peer keys and application roles independently of editable metadata."""
from alembic import op
import sqlalchemy as sa

revision = "0093_device_peer_identity"
down_revision = "0092_task_text_storage"
branch_labels = None
depends_on = None


def upgrade():
    op.create_table("client_peer_identity", sa.Column("client_id", sa.String(64), primary_key=True),
                    sa.Column("role", sa.String(16), nullable=False),
                    sa.Column("public_key", sa.String(256), nullable=False))


def downgrade():
    if op.get_bind().execute(sa.text("SELECT 1 FROM client_peer_identity LIMIT 1")).first():
        raise RuntimeError("Cannot discard enrolled peer keys or immutable roles; retain this schema or restore a matching backup")
    op.drop_table("client_peer_identity")
