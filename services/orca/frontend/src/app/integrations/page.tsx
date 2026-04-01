import type { Metadata } from 'next';

export const metadata: Metadata = { title: 'Integrations — Orca' };

/* ── Brand logos ──────────────────────────────────────────────────────── */

function GrafanaLogo() {
  return (
    <svg viewBox="0 0 256 256" xmlns="http://www.w3.org/2000/svg" className="w-5 h-5">
      <defs>
        <radialGradient id="grafana-grad" cx="46%" cy="20%" r="76%" fx="46%" fy="20%">
          <stop offset="0%" stopColor="#FBCA0A" />
          <stop offset="100%" stopColor="#F05A28" />
        </radialGradient>
      </defs>
      <circle cx="128" cy="128" r="128" fill="url(#grafana-grad)" />
      <path fillRule="evenodd" clipRule="evenodd" d="M128 36C77.1 36 36 77.1 36 128s41.1 92 92 92 92-41.1 92-92-41.1-92-92-92zm0 13c43.6 0 79 35.4 79 79s-35.4 79-79 79-79-35.4-79-79 35.4-79 79-79z" fill="white" />
      <ellipse cx="100" cy="128" rx="20" ry="28" fill="white" />
      <ellipse cx="156" cy="128" rx="20" ry="28" fill="white" />
      <rect x="100" y="120" width="56" height="16" fill="white" />
      <rect x="121" y="44" width="14" height="20" rx="7" fill="white" />
      <rect x="121" y="192" width="14" height="20" rx="7" fill="white" />
      <rect x="44" y="121" width="20" height="14" rx="7" fill="white" />
      <rect x="192" y="121" width="20" height="14" rx="7" fill="white" />
    </svg>
  );
}

function SlackLogo() {
  return (
    <svg viewBox="0 0 124 124" xmlns="http://www.w3.org/2000/svg" className="w-5 h-5">
      <path d="M26.2 78.5c0 7.2-5.9 13.1-13.1 13.1S0 85.7 0 78.5s5.9-13.1 13.1-13.1H26.2v13.1z" fill="#E01E5A" />
      <path d="M32.8 78.5c0-7.2 5.9-13.1 13.1-13.1s13.1 5.9 13.1 13.1v32.8c0 7.2-5.9 13.1-13.1 13.1S32.8 118.5 32.8 111.3V78.5z" fill="#E01E5A" />
      <path d="M45.9 26.2c-7.2 0-13.1-5.9-13.1-13.1S38.7 0 45.9 0s13.1 5.9 13.1 13.1v13.1H45.9z" fill="#36C5F0" />
      <path d="M45.9 32.8c7.2 0 13.1 5.9 13.1 13.1s-5.9 13.1-13.1 13.1H13.1C5.9 59 0 53.1 0 45.9s5.9-13.1 13.1-13.1H45.9z" fill="#36C5F0" />
      <path d="M97.8 45.9c0-7.2 5.9-13.1 13.1-13.1S124 38.7 124 45.9s-5.9 13.1-13.1 13.1H97.8V45.9z" fill="#2EB67D" />
      <path d="M91.2 45.9c0 7.2-5.9 13.1-13.1 13.1S65 53.1 65 45.9V13.1C65 5.9 70.9 0 78.1 0s13.1 5.9 13.1 13.1V45.9z" fill="#2EB67D" />
      <path d="M78.1 97.8c7.2 0 13.1 5.9 13.1 13.1S85.3 124 78.1 124s-13.1-5.9-13.1-13.1V97.8H78.1z" fill="#ECB22E" />
      <path d="M78.1 91.2c-7.2 0-13.1-5.9-13.1-13.1s5.9-13.1 13.1-13.1H111c7.2 0 13.1 5.9 13.1 13.1s-5.9 13.1-13.1 13.1H78.1z" fill="#ECB22E" />
    </svg>
  );
}

/* ── Static integration data ──────────────────────────────────────────── */

interface Integration {
  id: string;
  name: string;
  type: string;
  direction: 'incoming' | 'outgoing';
  status: 'active' | 'inactive';
  description: string;
  logo: React.ReactNode;
  detail: string;
}

const INTEGRATIONS: Integration[] = [
  {
    id: 'grafana-webhook',
    name: 'Context',
    type: 'Webhook',
    direction: 'incoming',
    status: 'active',
    description: 'Receives firing alert payloads from Grafana Unified Alerting.',
    logo: <GrafanaLogo />,
    detail: 'POST /webhook/grafana',
  },
  {
    id: 'slack',
    name: 'Slack',
    type: 'Notification',
    direction: 'outgoing',
    status: 'active',
    description: 'Pushes completed RCA reports and confidence summaries to a Slack channel.',
    logo: <SlackLogo />,
    detail: 'Outgoing Webhook URL',
  },
];

const incoming = INTEGRATIONS.filter((i) => i.direction === 'incoming');
const outgoing = INTEGRATIONS.filter((i) => i.direction === 'outgoing');

/* ── Sub-components ───────────────────────────────────────────────────── */

function StatusPill({ status }: { status: 'active' | 'inactive' }) {
  return (
    <span className={`inline-flex items-center gap-1.5 text-xs font-medium ${status === 'active' ? 'text-success' : 'text-muted-foreground'}`}>
      <span className={`w-2 h-2 rounded-full ${status === 'active' ? 'bg-success' : 'bg-muted-foreground/30'}`} />
      {status === 'active' ? 'Active' : 'Inactive'}
    </span>
  );
}

function IntegrationRow({ item }: { item: Integration }) {
  return (
    <tr className="border-b border-border last:border-b-0 hover:bg-muted/50 transition-colors">
      <td className="px-5 py-4 w-[50%]">
        <div className="flex items-center gap-3">
          <div className="w-9 h-9 rounded-lg bg-muted flex items-center justify-center shrink-0">
            {item.logo}
          </div>
          <div>
            <p className="text-sm font-medium text-foreground">{item.name}</p>
            <p className="text-xs text-muted-foreground mt-0.5">{item.description}</p>
          </div>
        </div>
      </td>
      <td className="px-5 py-4 w-[15%]">
        <span className="text-sm text-secondary-foreground">{item.type}</span>
      </td>
      <td className="px-5 py-4 w-[25%]">
        <code className="text-xs font-mono bg-muted text-foreground px-2 py-0.5 rounded">
          {item.detail}
        </code>
      </td>
      <td className="px-5 py-4 w-[10%]">
        <StatusPill status={item.status} />
      </td>
    </tr>
  );
}

function ColGroup() {
  return (
    <colgroup>
      <col className="w-[50%]" />
      <col className="w-[15%]" />
      <col className="w-[25%]" />
      <col className="w-[10%]" />
    </colgroup>
  );
}

function Section({ title, subtitle, items }: { title: string; subtitle: string; items: Integration[] }) {
  return (
    <div className="bg-card rounded-lg border border-border overflow-hidden">
      <div className="px-5 py-4 border-b border-border">
        <h2 className="text-base font-semibold text-foreground">{title}</h2>
        <p className="text-sm text-muted-foreground mt-0.5">{subtitle}</p>
      </div>
      <table className="min-w-full table-fixed">
        <ColGroup />
        <thead>
          <tr className="border-b border-border">
            {['Integration', 'Type', 'Endpoint / Method', 'Status'].map((h) => (
              <th key={h} className="px-5 py-3 text-left text-xs font-medium text-muted-foreground">
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {items.map((item) => (
            <IntegrationRow key={item.id} item={item} />
          ))}
        </tbody>
      </table>
    </div>
  );
}

/* ── Page ─────────────────────────────────────────────────────────────── */

export default function IntegrationsPage() {
  return (
    <div className="space-y-8">
      <Section title="Incoming" subtitle="External systems that trigger Orca investigations" items={incoming} />
      <Section title="Outgoing" subtitle="Channels Orca uses to publish reports and notifications" items={outgoing} />
    </div>
  );
}
