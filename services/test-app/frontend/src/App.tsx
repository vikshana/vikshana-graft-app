import { useCallback, useEffect, useState } from 'react'

type ChaosMode = 'error' | 'latency' | 'exception'

interface EndpointStatus {
  path: string
  label: string
  status: 'ok' | 'error' | 'loading' | 'idle'
  latencyMs?: number
}

interface ChaosStatus {
  active: boolean
  mode: ChaosMode | null
}

const ENDPOINTS = [
  { path: '/api/orders', label: 'Orders' },
  { path: '/api/products', label: 'Products' },
  { path: '/api/users', label: 'Users' },
]

const CHAOS_OPTIONS: { mode: ChaosMode; label: string; desc: string }[] = [
  { mode: 'error', label: 'HTTP 500 Errors', desc: '60% of requests fail with HTTP 500' },
  { mode: 'latency', label: 'High Latency', desc: 'Random 1–5s delay injected per request' },
  { mode: 'exception', label: 'Unhandled Exception', desc: 'Raises RuntimeError inside the handler' },
]

function statusColor(s: EndpointStatus['status']) {
  return s === 'ok' ? '#22c55e' : s === 'error' ? '#ef4444' : s === 'loading' ? '#f59e0b' : '#475569'
}

export default function App() {
  const [statuses, setStatuses] = useState<EndpointStatus[]>(
    ENDPOINTS.map((e) => ({ ...e, status: 'idle' as const })),
  )
  const [chaos, setChaos] = useState<ChaosStatus>({ active: false, mode: null })
  const [polling, setPolling] = useState(false)

  const probe = useCallback(async () => {
    setStatuses((prev) => prev.map((s) => ({ ...s, status: 'loading' as const })))
    const results = await Promise.all(
      ENDPOINTS.map(async (e) => {
        const t0 = Date.now()
        try {
          const r = await fetch(e.path, { signal: AbortSignal.timeout(8000) })
          return { ...e, status: (r.ok ? 'ok' : 'error') as 'ok' | 'error', latencyMs: Date.now() - t0 }
        } catch {
          return { ...e, status: 'error' as const, latencyMs: Date.now() - t0 }
        }
      }),
    )
    setStatuses(results)
  }, [])

  const fetchChaos = useCallback(async () => {
    try {
      const r = await fetch('/api/chaos/status')
      setChaos(await r.json())
    } catch {
      // ignore network errors
    }
  }, [])

  useEffect(() => {
    fetchChaos()
    if (!polling) return
    const id = setInterval(() => {
      probe()
      fetchChaos()
    }, 3000)
    return () => clearInterval(id)
  }, [polling, probe, fetchChaos])

  const toggleChaos = async (mode: ChaosMode) => {
    const isActive = chaos.active && chaos.mode === mode
    if (isActive) {
      await fetch('/api/chaos/disable', { method: 'POST' })
      setChaos({ active: false, mode: null })
    } else {
      await fetch(`/api/chaos/enable?type=${mode}`, { method: 'POST' })
      setChaos({ active: true, mode })
    }
  }

  const disableAll = async () => {
    await fetch('/api/chaos/disable', { method: 'POST' })
    setChaos({ active: false, mode: null })
  }

  const cardStyle: React.CSSProperties = {
    background: '#1e293b',
    borderRadius: 8,
    padding: '1.25rem',
  }

  const btnBase: React.CSSProperties = {
    border: '1px solid #334155',
    borderRadius: 4,
    cursor: 'pointer',
    fontSize: '0.75rem',
    padding: '0.3rem 0.75rem',
  }

  return (
    <div
      style={{
        fontFamily: 'system-ui, sans-serif',
        maxWidth: 960,
        margin: '0 auto',
        padding: '2rem',
        color: '#e2e8f0',
        minHeight: '100vh',
      }}
    >
      <h1 style={{ fontSize: '1.5rem', fontWeight: 700, marginBottom: '0.25rem' }}>Test App</h1>
      <p style={{ color: '#64748b', fontSize: '0.875rem', marginBottom: '2rem' }}>
        Generates OpenTelemetry traces, metrics, and logs. Use chaos injection to trigger Grafana alerts and Orca RCA.
      </p>

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '1.5rem' }}>
        {/* API Status */}
        <div style={cardStyle}>
          <div
            style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '1rem' }}
          >
            <h2 style={{ fontSize: '1rem', fontWeight: 600, margin: 0 }}>API Endpoints</h2>
            <div style={{ display: 'flex', gap: '0.5rem' }}>
              <button onClick={probe} style={{ ...btnBase, background: '#0f172a', color: '#94a3b8' }}>
                Probe once
              </button>
              <button
                onClick={() => setPolling((p) => !p)}
                style={{
                  ...btnBase,
                  background: polling ? '#14532d' : '#1e293b',
                  color: polling ? '#86efac' : '#94a3b8',
                  border: polling ? '1px solid #166534' : '1px solid #334155',
                }}
              >
                {polling ? '⏹ Stop' : '▶ Auto-poll'}
              </button>
            </div>
          </div>

          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '0.875rem' }}>
            <thead>
              <tr style={{ color: '#475569', textAlign: 'left' }}>
                <th style={{ paddingBottom: '0.5rem', fontWeight: 500 }}>Endpoint</th>
                <th style={{ paddingBottom: '0.5rem', fontWeight: 500 }}>Status</th>
                <th style={{ paddingBottom: '0.5rem', fontWeight: 500, textAlign: 'right' }}>Latency</th>
              </tr>
            </thead>
            <tbody>
              {statuses.map((s) => (
                <tr key={s.path} style={{ borderTop: '1px solid #334155' }}>
                  <td style={{ padding: '0.6rem 0', fontFamily: 'monospace', fontSize: '0.8rem', color: '#94a3b8' }}>
                    {s.path}
                  </td>
                  <td style={{ padding: '0.6rem 0' }}>
                    <span style={{ display: 'inline-flex', alignItems: 'center', gap: '0.4rem' }}>
                      <span
                        style={{
                          width: 8,
                          height: 8,
                          borderRadius: '50%',
                          background: statusColor(s.status),
                          display: 'inline-block',
                        }}
                      />
                      <span style={{ color: statusColor(s.status), textTransform: 'capitalize', fontSize: '0.8rem' }}>
                        {s.status}
                      </span>
                    </span>
                  </td>
                  <td style={{ padding: '0.6rem 0', textAlign: 'right', color: '#475569', fontFamily: 'monospace', fontSize: '0.8rem' }}>
                    {s.latencyMs !== undefined ? `${s.latencyMs}ms` : '—'}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        {/* Chaos Panel */}
        <div style={cardStyle}>
          <div
            style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '0.75rem' }}
          >
            <h2 style={{ fontSize: '1rem', fontWeight: 600, margin: 0 }}>Chaos Engineering</h2>
            {chaos.active && (
              <span
                style={{
                  fontSize: '0.7rem',
                  padding: '0.2rem 0.6rem',
                  borderRadius: 12,
                  background: '#450a0a',
                  color: '#fca5a5',
                  fontWeight: 600,
                }}
              >
                ● ACTIVE: {chaos.mode}
              </span>
            )}
          </div>
          <p style={{ fontSize: '0.8rem', color: '#475569', marginBottom: '1.25rem', lineHeight: 1.5 }}>
            Injects faults into all API endpoints. Active chaos generates error signals that trigger Grafana alert rules
            and Orca RCA investigations.
          </p>

          <div style={{ display: 'flex', flexDirection: 'column', gap: '0.625rem' }}>
            {CHAOS_OPTIONS.map(({ mode, label, desc }) => {
              const active = chaos.active && chaos.mode === mode
              const activeBg = mode === 'error' ? '#7f1d1d' : mode === 'latency' ? '#78350f' : '#3b0764'
              return (
                <button
                  key={mode}
                  onClick={() => toggleChaos(mode)}
                  style={{
                    background: active ? activeBg : '#0f172a',
                    border: active ? '1px solid rgba(255,255,255,0.15)' : '1px solid #334155',
                    borderRadius: 6,
                    padding: '0.75rem 1rem',
                    textAlign: 'left',
                    cursor: 'pointer',
                    color: '#e2e8f0',
                    transition: 'background 0.15s',
                  }}
                >
                  <div style={{ fontWeight: 600, fontSize: '0.875rem', marginBottom: '0.2rem' }}>
                    {active ? '■ Disable' : '▶ Enable'} — {label}
                  </div>
                  <div style={{ fontSize: '0.75rem', color: active ? 'rgba(226,232,240,0.6)' : '#475569' }}>{desc}</div>
                </button>
              )
            })}
          </div>

          <button
            onClick={disableAll}
            style={{
              marginTop: '1rem',
              width: '100%',
              padding: '0.5rem',
              fontSize: '0.75rem',
              borderRadius: 4,
              border: '1px solid #334155',
              background: 'transparent',
              color: '#475569',
              cursor: 'pointer',
            }}
          >
            Disable all chaos
          </button>
        </div>
      </div>

      {/* Footer */}
      <div
        style={{
          marginTop: '1.5rem',
          padding: '0.75rem 1rem',
          background: '#1e293b',
          borderRadius: 6,
          fontSize: '0.75rem',
          color: '#475569',
        }}
      >
        Telemetry → <span style={{ color: '#94a3b8' }}>OTel Collector :4317</span> → Traces:{' '}
        <span style={{ color: '#94a3b8' }}>Tempo</span> · Metrics:{' '}
        <span style={{ color: '#94a3b8' }}>Mimir</span> · Logs: <span style={{ color: '#94a3b8' }}>Loki</span>
        &nbsp;·&nbsp;
        <a href="http://localhost:3000" style={{ color: '#60a5fa' }}>
          Grafana :3000
        </a>
        &nbsp;·&nbsp;
        <a href="http://localhost:8001/docs" style={{ color: '#60a5fa' }}>
          Orca API :8001
        </a>
      </div>
    </div>
  )
}
