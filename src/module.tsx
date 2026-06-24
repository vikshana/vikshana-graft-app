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
    title: 'Ask Graft AI Assistant',
    description: 'Open the Graft AI Assistant with this panel as context',
    targets: [PluginExtensionPoints.DashboardPanelMenu],
    icon: 'comments-alt',
    configure: () => ({ title: 'Ask Graft' }),
    onClick: (_, helpers) => {
      const ctx = helpers.context;

      // Build fallback URL — used when no session exists yet (user hasn't sent
      // a message). Encodes panel context so full-page Graft pre-fills the prompt.
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
      const fallbackUrl = `${PLUGIN_BASE_URL}/?${openParams.toString()}`;

      // Shared mutable ref — ChatInterface writes the current sessionId here on
      // every render. The title-bar button reads it at click time so it always
      // gets the latest session even though it lives outside ChatInterface's tree.
      const sessionRef: React.MutableRefObject<{ sessionId?: string } | null> =
        { current: null };

      helpers.openModal({
        // JSX title: "Graft AI Assistant" on left, "Open in Graft ↗" on right.
        // Rendered in Grafana's fixed title bar row — never scrolls away.
        title: (
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', width: '100%', paddingRight: '8px' }}>
            <span>Graft AI Assistant</span>
            <button
              onClick={() => {
                const sid = sessionRef.current?.sessionId;
                if (sid) {
                  // Session exists — open full page and restore the conversation
                  window.open(`${PLUGIN_BASE_URL}/?chat=true&session=${sid}`, '_blank');
                } else {
                  // No session yet — open with panel context params for pre-fill
                  window.open(fallbackUrl, '_blank');
                }
              }}
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                gap: '4px',
                fontSize: '13px',
                color: 'inherit',
                opacity: 0.8,
                cursor: 'pointer',
                background: 'transparent',
                padding: '2px 8px',
                borderRadius: '4px',
                border: '1px solid currentColor',
                whiteSpace: 'nowrap',
              }}
            >
              Open in Graft ↗
            </button>
          </div>
        ) as unknown as string,
        ariaLabel: 'Graft AI Assistant',
        width: '85%',
        body: ({ onDismiss }) => (
          <GraftPanelModal panelContext={ctx} onDismiss={onDismiss} sessionRef={sessionRef} />
        ),
      });
    },
  })

  // ── Explore toolbar: "Ask Graft" ────────────────────────────────────────
  .addLink<ExploreContext>({
    title: 'Ask Graft AI Assistant (Explore)',
    description: 'Open the Graft AI Assistant with the current Explore query as context',
    targets: [PluginExtensionPoints.ExploreToolbarAction],
    icon: 'comments-alt',
    // Always show in the toolbar (static title ≥10 chars for plugin.json
    // validation; configure() overrides to the clean short label at runtime)
    configure: () => ({ title: 'Ask Graft' }),
    onClick: (_, helpers) => {
      const ctx = helpers.context as ExploreContext | undefined;

      // Build the Explore context object to pass into the modal as a prop
      const firstTarget = ctx?.targets?.[0];
      const exploreCtx = {
        dsUid:    firstTarget?.datasource?.uid,
        dsType:   firstTarget?.datasource?.type,
        from:     ctx?.timeRange?.from,
        to:       ctx?.timeRange?.to,
        timeZone: ctx?.timeZone,
        queries:  ctx?.targets?.map((t) => ({
          refId:  t.refId,
          expr:   t.expr ?? t.query ?? '',
          dsUid:  t.datasource?.uid,
          dsType: t.datasource?.type,
        })),
      };

      // Build fallback URL for "Open in Graft ↗" when no session exists yet —
      // same params the old link extension used to encode.
      const params = new URLSearchParams();
      if (exploreCtx.dsUid)  { params.set('dsUid',  exploreCtx.dsUid); }
      if (exploreCtx.dsType) { params.set('dsType', exploreCtx.dsType); }
      if (exploreCtx.from)   { params.set('from',   exploreCtx.from); }
      if (exploreCtx.to)     { params.set('to',     exploreCtx.to); }
      if (exploreCtx.timeZone) { params.set('tz',   exploreCtx.timeZone); }
      if (ctx?.targets?.length) {
        params.set('queries', JSON.stringify(exploreCtx.queries));
      }
      const qs = params.toString();
      const fallbackUrl = `${PLUGIN_BASE_URL}/${qs ? '?' + qs : ''}`;

      // Shared mutable ref — same sessionRef bridge pattern as the panel modal.
      const sessionRef: React.MutableRefObject<{ sessionId?: string } | null> =
        { current: null };

      helpers.openModal({
        // JSX title: "Graft AI Assistant" on left, "Open in Graft ↗" on right.
        title: (
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', width: '100%', paddingRight: '8px' }}>
            <span>Graft AI Assistant</span>
            <button
              onClick={() => {
                const sid = sessionRef.current?.sessionId;
                if (sid) {
                  window.open(`${PLUGIN_BASE_URL}/?chat=true&session=${sid}`, '_blank');
                } else {
                  window.open(fallbackUrl, '_blank');
                }
              }}
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                gap: '4px',
                fontSize: '13px',
                color: 'inherit',
                opacity: 0.8,
                cursor: 'pointer',
                background: 'transparent',
                padding: '2px 8px',
                borderRadius: '4px',
                border: '1px solid currentColor',
                whiteSpace: 'nowrap',
              }}
            >
              Open in Graft ↗
            </button>
          </div>
        ) as unknown as string,
        ariaLabel: 'Graft AI Assistant',
        width: '85%',
        body: ({ onDismiss }) => (
          <GraftPanelModal
            panelContext={undefined}
            exploreContext={exploreCtx}
            onDismiss={onDismiss}
            sessionRef={sessionRef}
          />
        ),
      });
    },
  });
