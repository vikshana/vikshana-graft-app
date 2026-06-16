import React, { Suspense, lazy } from 'react';
import { AppPlugin, type AppRootProps } from '@grafana/data';
import { LoadingPlaceholder } from '@grafana/ui';
import type { AppConfigProps } from './components/features/AppConfig/AppConfig';
import type { AgentConfigProps } from './components/features/AppConfig/AgentConfig';

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
  });
