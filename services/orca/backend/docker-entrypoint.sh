#!/usr/bin/env bash
# Production container entrypoint for the Orca backend.
#
# Alembic is the single schema authority for this service (see
# docs/harness-risk-review.md F3/F13). Before the application process
# starts, this script applies all outstanding migrations with
# `alembic upgrade head`. `app/main.py` no longer creates or alters
# schema at runtime — it only verifies (via app.schema_check) that the
# database is at the revision this image expects.
#
# Usage: this script is the Dockerfile ENTRYPOINT; CMD is passed through
# as "$@" and exec'd after migrations succeed, e.g.:
#   ENTRYPOINT ["./docker-entrypoint.sh"]
#   CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000"]
set -euo pipefail

echo "[docker-entrypoint] Running 'alembic upgrade head'..."
alembic upgrade head
echo "[docker-entrypoint] Migrations complete. Starting application..."

exec "$@"
