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

  // ── Panel context menu: "Ask Graft about this panel" ─────────────────────
  .addLink<PluginExtensionPanelContext>({
    title: 'Ask Graft about this panel',
    description: 'Open the Graft AI Assistant with this panel as context',
    targets: [PluginExtensionPoints.DashboardPanelMenu],
    icon: 'comments-alt',
    configure: (ctx) => (ctx?.title ? { title: `Ask Graft: "${ctx.title}"` } : {}),
    onClick: (_, helpers) => {
      const ctx = helpers.context;
      helpers.openModal({
        title: ctx?.title ? `Graft — ${ctx.title}` : 'Graft AI Assistant',
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
