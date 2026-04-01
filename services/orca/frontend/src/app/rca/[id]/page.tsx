import { notFound } from 'next/navigation';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { fetchRCADetail } from '@/lib/api';
import { StatusBadge, ConfidenceBadge } from '@/components/StatusBadge';
import { FeedbackForm } from '@/components/FeedbackForm';
import { ShareButton } from '@/components/ShareButton';
import { BreadcrumbSetter } from '@/components/BreadcrumbContext';
import type { AgentStep, DuplicateAlertInfo } from '@/types/rca';

interface RCADetailPageProps {
  params: { id: string };
}

function formatDate(dateStr: string | null): string {
  if (!dateStr) return '—';
  return new Date(dateStr).toLocaleString('en-GB', {
    day: '2-digit',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
}

function formatDuration(seconds: number | null): string {
  if (seconds === null || seconds === undefined) return '—';
  if (seconds < 60) return `${seconds.toFixed(1)}s`;
  const m = Math.floor(seconds / 60);
  const s = Math.round(seconds % 60);
  if (m >= 60) {
    const h = Math.floor(m / 60);
    const rm = m % 60;
    return `${h}h ${rm}m`;
  }
  return `${m}m ${s}s`;
}

function timeAgo(dateStr: string | null): string {
  if (!dateStr) return '';
  const diff = Date.now() - new Date(dateStr).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ${mins % 60}m ago`;
  return `${Math.floor(hrs / 24)}d ago`;
}

const NODE_COLORS: Record<string, string> = {
  triage: 'bg-warning',
  investigate: 'bg-accent',
  analyze: 'bg-violet-500',
  report: 'bg-indigo-500',
  publish: 'bg-success',
};

function TimelineStep({ step }: { step: AgentStep }) {
  const dotColor = NODE_COLORS[step.node_name] ?? 'bg-muted-foreground';

  return (
    <div className="flex gap-4">
      <div className="flex flex-col items-center">
        <div className={`w-7 h-7 rounded-full ${dotColor} flex items-center justify-center text-white text-[11px] font-semibold shrink-0`}>
          {step.step_number}
        </div>
        <div className="w-px flex-1 bg-border mt-2" />
      </div>
      <div className="pb-6 flex-1 min-w-0">
        <h4 className="text-sm font-medium text-foreground">
          {step.node_name.charAt(0).toUpperCase() + step.node_name.slice(1)}: {step.action}
        </h4>
        {step.output && (
          <p className="text-sm text-muted-foreground mt-1 line-clamp-3">
            {step.output.slice(0, 300)}
            {step.output.length > 300 ? '…' : ''}
          </p>
        )}
        <div className="flex items-center gap-4 mt-1.5 text-xs text-muted-foreground">
          {step.tokens_used && <span>{step.tokens_used.toLocaleString()} tokens</span>}
          {step.duration_seconds && <span>{step.duration_seconds.toFixed(2)}s</span>}
        </div>
      </div>
    </div>
  );
}

function DuplicateAlertRow({ dup, index }: { dup: DuplicateAlertInfo; index: number }) {
  return (
    <div className="flex items-center gap-3 py-2 border-b border-border last:border-0">
      <span className="text-muted-foreground text-sm w-6 text-right shrink-0">#{index + 1}</span>
      <div className="flex-1 min-w-0">
        <p className="text-xs font-mono text-muted-foreground truncate">{dup.alert_id}</p>
        <p className="text-xs text-muted-foreground">{formatDate(dup.created_at)}</p>
      </div>
    </div>
  );
}

export default async function RCADetailPage({ params }: RCADetailPageProps) {
  let rca;
  try {
    rca = await fetchRCADetail(params.id);
  } catch (err) {
    if (err instanceof Error && err.message.includes('not found')) {
      notFound();
    }
    throw err;
  }

  return (
    <div className="space-y-6">
      <BreadcrumbSetter name={rca.alert_name} />
      {/* Header */}
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          {rca.confidence_level && (
            <div className="mb-2">
              <ConfidenceBadge level={rca.confidence_level} reasoning={rca.confidence_reasoning} />
            </div>
          )}
          <h1 className="text-2xl font-bold text-foreground">{rca.alert_name}</h1>
          <p className="text-sm text-muted-foreground mt-1">
            <span className="font-mono text-accent">{rca.id.slice(0, 12)}</span>
            {rca.created_at && <span> · {timeAgo(rca.created_at)}</span>}
          </p>
        </div>
        <ShareButton />
      </div>

      {/* Status cards row */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        <div className="bg-card border border-border rounded-lg p-5">
          <p className="text-xs font-medium text-muted-foreground">Status</p>
          <div className="mt-2">
            <StatusBadge status={rca.status} className="text-base" />
          </div>
        </div>
        <div className="bg-card border border-border rounded-lg p-5">
          <p className="text-xs font-medium text-muted-foreground">Duration</p>
          <p className="text-2xl font-bold text-foreground mt-2">
            {formatDuration(rca.duration_seconds)}
          </p>
        </div>
        <div className="bg-card border border-border rounded-lg p-5">
          <p className="text-xs font-medium text-muted-foreground">Impact</p>
          <p className="text-2xl font-bold text-foreground mt-2">
            {rca.deployment_environment_name
              ? rca.deployment_environment_name
              : rca.service_name ?? '—'}
          </p>
        </div>
      </div>

      {/* Error message */}
      {rca.error_message && (
        <div className="bg-red-50 border border-red-200 rounded-lg p-4">
          <p className="text-sm font-semibold text-destructive mb-1">Agent Error</p>
          <p className="text-sm text-destructive/80">{rca.error_message}</p>
        </div>
      )}

      {/* Metadata */}
      <div className="bg-card border border-border rounded-lg p-5">
        <h3 className="text-sm font-medium text-muted-foreground mb-3">Investigation Details</h3>
        <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
          {[
            { label: 'Service', value: rca.service_name },
            { label: 'Environment', value: rca.deployment_environment_name },
            { label: 'Team', value: rca.team },
            { label: 'Domain', value: rca.domain },
            { label: 'Sub-Domain', value: rca.sub_domain },
            { label: 'System ID', value: rca.system_id },
            { label: 'Steps', value: rca.total_steps?.toString() ?? '—' },
            { label: 'Tokens', value: rca.total_tokens?.toLocaleString() ?? '—' },
          ].map(({ label, value }) => (
            <div key={label}>
              <p className="text-xs text-muted-foreground">{label}</p>
              <p className="text-sm text-foreground mt-0.5">{value ?? '—'}</p>
            </div>
          ))}
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        {/* RCA Report */}
        <div className="lg:col-span-2 space-y-4">
          {rca.report_markdown ? (
            <div className="bg-card border border-border rounded-lg p-6">
              <h2 className="font-display text-base font-semibold text-foreground mb-4 border-b border-border pb-2">
              RCA Report
            </h2>
              <div className="prose max-w-none">
                <ReactMarkdown remarkPlugins={[remarkGfm]}>
                  {rca.report_markdown}
                </ReactMarkdown>
              </div>
            </div>
          ) : (
            <div className="bg-card border border-border rounded-lg p-6 text-center text-muted-foreground">
              {rca.status === 'investigating' || rca.status === 'triggered'
                ? '⏳ Investigation in progress…'
                : 'No report generated'}
            </div>
          )}
        </div>

        {/* Agent Steps Timeline */}
        <div className="space-y-4">
          <div className="bg-card border border-border rounded-lg p-5">
            <h2 className="text-sm font-semibold text-foreground mb-4 flex items-center gap-2">
              <svg className="w-4 h-4 text-accent" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.6}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M9.75 3.104v5.714a2.25 2.25 0 01-.659 1.591L5 14.5M9.75 3.104c-.251.023-.501.05-.75.082m.75-.082a24.301 24.301 0 014.5 0m0 0v5.714c0 .597.237 1.17.659 1.591L19.8 15.3M14.25 3.104c.251.023.501.05.75.082M19.8 15.3l-1.57.393A9.065 9.065 0 0112 15a9.065 9.065 0 00-6.23.693L5 14.5m14.8.8l1.402 1.402c1.232 1.232.65 3.318-1.067 3.611A48.309 48.309 0 0112 21c-2.773 0-5.491-.235-8.135-.687-1.718-.293-2.3-2.379-1.067-3.61L5 14.5" />
              </svg>
              Agent Steps
            </h2>
            {rca.steps.length === 0 ? (
              <p className="text-sm text-muted-foreground text-center py-4">No steps recorded yet</p>
            ) : (
              <div>
                {rca.steps.map((step) => (
                  <TimelineStep key={step.id} step={step} />
                ))}
              </div>
            )}
          </div>

          {/* Duplicate Alerts */}
          {rca.duplicate_alerts.length > 0 && (
            <div className="bg-amber-50 border border-amber-200 rounded-lg p-4">
              <h2 className="text-sm font-semibold text-amber-800 mb-1">
                Duplicate Alerts ({rca.duplicate_alerts.length})
              </h2>
              <p className="text-xs text-amber-600 mb-3">
                These alerts matched this RCA and were suppressed.
              </p>
              <div className="divide-y divide-amber-100">
                {rca.duplicate_alerts.map((dup, i) => (
                  <DuplicateAlertRow key={dup.id} dup={dup} index={i} />
                ))}
              </div>
            </div>
          )}
        </div>
      </div>

      {/* Feedback */}
      <FeedbackForm
        rcaId={rca.id}
        initialRating={rca.feedback_rating}
        initialComment={rca.feedback_comment}
      />
    </div>
  );
}
