"""Insert dummy completed RCA records for development/demo purposes.

Run via:
    docker compose exec -T orca-backend python < services/orca/backend/scripts/seed_dummy.py
"""
import asyncio
from datetime import datetime, timedelta, timezone

from sqlalchemy.ext.asyncio import AsyncSession, create_async_engine
from sqlalchemy.orm import sessionmaker

from app.config import settings
from app.models.rca import RCA

engine = create_async_engine(settings.DATABASE_URL, echo=False)
SessionLocal = sessionmaker(engine, class_=AsyncSession, expire_on_commit=False)

DUMMY_RCAS = [
    dict(
        alert_name="HighErrorRate",
        status="complete",
        service_name="checkout-service",
        deployment_environment_name="production",
        domain="commerce",
        legal_company="acme-corp",
        sub_domain="checkout",
        system_id="sys-001",
        team="checkout-team",
        version="2.4.1",
        root_cause=(
            "Database connection pool exhaustion caused by a memory leak in the connection "
            "handler introduced in v2.4.0."
        ),
        confidence_level="high",
        confidence_reasoning=(
            "Correlated with deployment of v2.4.0; connection pool metrics show gradual "
            "exhaustion over 4 hours with full recovery after rollback to v2.3.9."
        ),
        report_markdown=(
            "# Root Cause Analysis: HighErrorRate\n\n"
            "## Summary\nHigh error rate (~18%) on `checkout-service` caused by DB connection pool exhaustion.\n\n"
            "## Timeline\n"
            "- **14:00 UTC** Error rate begins climbing after v2.4.0 deploy\n"
            "- **16:30 UTC** Alert fires at p99 > 5 s\n"
            "- **17:45 UTC** Root cause identified; rollback initiated\n\n"
            "## Root Cause\n"
            "Memory leak in `pool.py:183` introduced in v2.4.0 prevented proper return of "
            "connections on request timeout.\n\n"
            "## Remediation\n1. Roll back to v2.3.9\n2. Fix leak in `pool.py`\n"
            "3. Add connection pool saturation alert"
        ),
        total_steps=12,
        total_tokens=8500,
        duration_seconds=45.2,
        error_message=None,
    ),
    dict(
        alert_name="PaymentServiceLatency",
        status="complete",
        service_name="payment-service",
        deployment_environment_name="production",
        domain="commerce",
        legal_company="acme-corp",
        sub_domain="payments",
        system_id="sys-002",
        team="payments-team",
        version="1.8.3",
        root_cause=(
            "Third-party payment processor experiencing elevated latency due to infrastructure "
            "issues on their end."
        ),
        confidence_level="medium",
        confidence_reasoning=(
            "Payment processor status page confirms degraded performance. Internal metrics show "
            "latency spikes correlated with processor response times, but cannot rule out "
            "intermediary network issues."
        ),
        report_markdown=(
            "# Root Cause Analysis: PaymentServiceLatency\n\n"
            "## Summary\nP99 latency exceeded SLA for 40 minutes due to external payment processor degradation.\n\n"
            "## Root Cause\n"
            "External dependency (`stripe-gateway`) response times increased 8x during a planned "
            "infrastructure migration on the processor's side.\n\n"
            "## Remediation\n1. Enable circuit breaker for payment processor calls\n"
            "2. Add synthetic monitoring for processor endpoint"
        ),
        total_steps=8,
        total_tokens=5200,
        duration_seconds=31.7,
        error_message=None,
    ),
    dict(
        alert_name="AuthServiceMemorySpike",
        status="complete",
        service_name="auth-service",
        deployment_environment_name="production",
        domain="platform",
        legal_company="acme-corp",
        sub_domain="identity",
        system_id="sys-005",
        team="platform-team",
        version="4.0.2",
        root_cause=(
            "JWT token validation cache grew unbounded due to missing TTL configuration "
            "after a config change in v4.0.0."
        ),
        confidence_level="high",
        confidence_reasoning=(
            "Heap dump confirms 94% of memory occupied by token cache entries. Config diff "
            "shows TTL removed in v4.0.0 migration."
        ),
        report_markdown=(
            "# Root Cause Analysis: AuthServiceMemorySpike\n\n"
            "## Summary\nMemory usage on `auth-service` climbed to 98% over 6 hours, causing OOM restarts.\n\n"
            "## Root Cause\n"
            "JWT validation cache TTL was accidentally removed during v4.0.0 config migration, "
            "causing unbounded cache growth.\n\n"
            "## Remediation\n1. Restore `cache.ttl = 3600` in config\n"
            "2. Add memory usage alert at 80% threshold"
        ),
        total_steps=15,
        total_tokens=11200,
        duration_seconds=62.3,
        error_message=None,
    ),
    dict(
        alert_name="OrderServiceHighLatency",
        status="investigating",
        service_name="order-service",
        deployment_environment_name="staging",
        domain="commerce",
        legal_company="acme-corp",
        sub_domain="orders",
        system_id="sys-003",
        team="orders-team",
        version="3.1.0",
        root_cause=None,
        confidence_level=None,
        confidence_reasoning=None,
        report_markdown=None,
        total_steps=4,
        total_tokens=2100,
        duration_seconds=None,
        error_message=None,
    ),
    dict(
        alert_name="InventoryServiceDiskFull",
        status="failed",
        service_name="inventory-service",
        deployment_environment_name="production",
        domain="logistics",
        legal_company="acme-corp",
        sub_domain="inventory",
        system_id="sys-004",
        team="logistics-team",
        version="1.0.5",
        root_cause=None,
        confidence_level=None,
        confidence_reasoning=None,
        report_markdown=None,
        total_steps=2,
        total_tokens=800,
        duration_seconds=None,
        error_message="MCP connection timeout: could not reach grafana:3000 within 30s",
    ),
]


async def seed() -> None:
    now = datetime.now(timezone.utc)
    async with SessionLocal() as session:
        for i, data in enumerate(DUMMY_RCAS):
            started = now - timedelta(hours=len(DUMMY_RCAS) - i, minutes=30)
            completed = (
                started + timedelta(seconds=data["duration_seconds"])
                if data.get("duration_seconds")
                else None
            )
            rca = RCA(
                alert_name=data["alert_name"],
                status=data["status"],
                service_name=data["service_name"],
                deployment_environment_name=data["deployment_environment_name"],
                domain=data["domain"],
                legal_company=data["legal_company"],
                sub_domain=data["sub_domain"],
                system_id=data["system_id"],
                team=data["team"],
                version=data["version"],
                root_cause=data.get("root_cause"),
                confidence_level=data.get("confidence_level"),
                confidence_reasoning=data.get("confidence_reasoning"),
                report_markdown=data.get("report_markdown"),
                total_steps=data.get("total_steps"),
                total_tokens=data.get("total_tokens"),
                duration_seconds=data.get("duration_seconds"),
                error_message=data.get("error_message"),
                started_at=started,
                completed_at=completed,
            )
            session.add(rca)
            print(f"  + {data['alert_name']!r} ({data['status']})")
        await session.commit()
    await engine.dispose()
    print("Seeded 5 dummy RCAs.")


asyncio.run(seed())
