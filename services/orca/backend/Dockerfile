FROM python:3.12-slim

# Install system dependencies (needed for asyncpg, npx for MCP servers)
RUN apt-get update && apt-get install -y --no-install-recommends \
    curl \
    nodejs \
    npm \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Copy and install Python dependencies
COPY pyproject.toml .
RUN pip install --no-cache-dir -e "."
# Bootstrap OTel auto-instrumentation packages for detected libraries
RUN opentelemetry-bootstrap -a install

# Copy application code
COPY app/ ./app/
COPY harness/ ./harness/

# Alembic is the sole schema authority in production (see
# docs/harness-risk-review.md F3/F13) — ship its config and migration
# scripts, and run `alembic upgrade head` via the entrypoint before uvicorn.
COPY alembic.ini .
COPY docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
RUN chmod +x /usr/local/bin/docker-entrypoint.sh

# Run as non-root user
RUN useradd -m orca && chown -R orca:orca /app
USER orca

EXPOSE 8000

ENTRYPOINT ["docker-entrypoint.sh"]
CMD ["opentelemetry-instrument", "uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000"]

