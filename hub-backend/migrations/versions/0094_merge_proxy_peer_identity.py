"""Join the proxy usage and device identity revisions at a single upgrade head."""

revision = "0094_merge_proxy_peer_identity"
down_revision = ("0093_proxy_usage_shadow", "0093_device_peer_identity")
branch_labels = None
depends_on = None


def upgrade() -> None:
    pass


def downgrade() -> None:
    pass
