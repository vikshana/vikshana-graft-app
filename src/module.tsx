import React, { Suspense, lazy } from 'react';
import { AppPlugin, type AppRootProps, PluginExtensionPoints, type PluginExtensionPanelContext } from '@grafana/data';
import { LoadingPlaceholder } from '@grafana/ui';
import type { AppConfigProps } from './components/features/AppConfig/AppConfig';
import type { AgentConfigProps } from './components/features/AppConfig/AgentConfig';
import { PLUGIN_BASE_URL } from './constants';
import { GraftPanelModal } from './components/features/GraftPanelModal/GraftPanelModal';

/** Context passed by Grafana Explore to ExploreToolbarAction extension points.
 *  Not exported from @grafana/data — defined locally from Grafana core source. */
interface ExploreContext {
  exploreId: string;
  targets: Array<{
    refId: string;
    expr?: string;
    query?: string;
    datasource?: { uid?: string; type?: string };
  }>;
  timeRange: { from: string; to: string };
  timeZone: string;
}

const LazyApp = lazy(() => import('./components/features/App/App'));
const LazyAppConfig = lazy(() => import('./components/features/AppConfig/AppConfig'));
const LazyAgentConfig = lazy(() => import('./components/features/AppConfig/AgentConfig'));

import { mcp } from '@grafana/llm';

const App = (props: AppRootProps) => (
  <Suspense fallback={<LoadingPlaceholder text="" />}>
    <mcp.MCPClientProvider appName="vikshana-graft-app" appVersion="0.1.0">
      <LazyApp {...props} />
    </mcp.MCPClientProvider>
  </Suspense>
);

const AppConfig = (props: AppConfigProps) => (
  <Suspense fallback={<LoadingPlaceholder text="" />}>
    <LazyAppConfig {...props} />
  </Suspense>
);

const AgentConfig = (props: AgentConfigProps) => (
  <Suspense fallback={<LoadingPlaceholder text="" />}>
    <LazyAgentConfig {...props} />
  </Suspense>
);

export const plugin = new AppPlugin<{}>()
  .setRootPage(App)
  .addConfigPage({
    title: 'Configuration',
    icon: 'cog',
    body: AppConfig,
    id: 'configuration',
  })
  .addConfigPage({
    title: 'Agent',
    icon: 'bolt',
    body: AgentConfig,
    id: 'agent',
  })

  // ── Panel context menu: "Ask Graft" ─────────────────────────────────────
  .addLink<PluginExtensionPanelContext>({
    title: 'Ask Graft...',
    description: 'Open the Graft AI Assistant with this panel as context',
    targets: [PluginExtensionPoints.DashboardPanelMenu],
    icon: 'comments-alt',
    // Always show "Ask Graft" in the menu (static title is ≥10 chars for
    // plugin.json validation; configure() overrides to the clean short label)
    configure: () => ({ title: 'Ask Graft' }),
    onClick: (_, helpers) => {
      const ctx = helpers.context;

      // Build URL params for "Open in Graft" — encodes panel context so
      // the full-page Graft pre-fills the input with the same prompt.
      const openParams = new URLSearchParams({
        panelTitle:     ctx?.title ?? '',
        dashboardUid:   ctx?.dashboard.uid ?? '',
        dashboardTitle: ctx?.dashboard.title ?? '',
        panelId:        String(ctx?.id ?? ''),
        panelPlugin:    ctx?.pluginId ?? '',
        from:           ctx?.timeRange.from ?? 'now-1h',
        to:             ctx?.timeRange.to ?? 'now',
        tz:             ctx?.timeZone ?? 'browser',
      });
      const dsUid = ctx?.targets?.[0]?.datasource?.uid;
      if (dsUid) { openParams.set('dsUid', dsUid); }
      const openInGraftUrl = `${PLUGIN_BASE_URL}/?${openParams.toString()}`;

      helpers.openModal({
        // JSX title: "Graft AI Assistant" on left, "Open in Graft ↗" button on right.
        // This renders inside Grafana's fixed modal title bar so the button
        // is always visible regardless of how far the user scrolls.
        title: (
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', width: '100%', paddingRight: '8px' }}>
            <span>Graft AI Assistant</span>
            <a
              href={openInGraftUrl}
              target="_blank"
              rel="noopener noreferrer"
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                gap: '4px',
                fontSize: '13px',
                color: 'inherit',
                opacity: 0.8,
                textDecoration: 'none',
                padding: '2px 8px',
                borderRadius: '4px',
                border: '1px solid currentColor',
                whiteSpace: 'nowrap',
              }}
            >
              Open in Graft ↗
            </a>
          </div>
        ) as unknown as string,
        ariaLabel: 'Graft AI Assistant',
        width: '85%',
        body: ({ onDismiss }) => (
          <GraftPanelModal panelContext={ctx} onDismiss={onDismiss} />
        ),
      });
    },
  })

  // ── Explore toolbar: "Analyze in Graft AI Assistant" ─────────────────────
  .addLink<ExploreContext>({
    title: 'Analyze in Graft AI Assistant',
    description: 'Send current Explore query to Graft for AI analysis',
    targets: [PluginExtensionPoints.ExploreToolbarAction],
    icon: 'comments-alt',
    openInNewTab: true,
    // Static fallback path required for registration validation;
    // configure() overrides with context-enriched params when available.
    path: PLUGIN_BASE_URL + '/',
    configure: (ctx) => {
      const params = new URLSearchParams();
      const firstTarget = ctx?.targets?.[0];
      if (firstTarget?.datasource?.uid) {
        params.set('dsUid', firstTarget.datasource.uid);
      }
      if (firstTarget?.datasource?.type) {
        params.set('dsType', firstTarget.datasource.type);
      }
      if (ctx?.timeRange?.from) { params.set('from', ctx.timeRange.from); }
      if (ctx?.timeRange?.to)   { params.set('to',   ctx.timeRange.to); }
      if (ctx?.timeZone)        { params.set('tz',   ctx.timeZone); }
      if (ctx?.targets?.length) {
        params.set(
          'queries',
          JSON.stringify(
            ctx.targets.map((t) => ({
              refId: t.refId,
              expr: t.expr ?? t.query ?? '',
              dsUid: t.datasource?.uid,
              dsType: t.datasource?.type,
            }))
          )
        );
      }
      const qs = params.toString();
      return { path: `${PLUGIN_BASE_URL}/${qs ? '?' + qs : ''}` };
    },
  });
