import React, { Suspense, lazy } from 'react';
import { AppPlugin, type AppRootProps } from '@grafana/data';
import { LoadingPlaceholder } from '@grafana/ui';
import type { AppConfigProps } from './components/features/AppConfig/AppConfig';

const LazyApp = lazy(() => import('./components/features/App/App'));
const LazyAppConfig = lazy(() => import('./components/features/AppConfig/AppConfig'));

import { mcp } from '@grafana/llm';
import { GRAFT_BUILD_VERSION } from './buildInfo';
// Eager import so chatHistoryService global singleton exists before lazy route chunks load
import './services/chatHistory';

const App = (props: AppRootProps) => (
  <Suspense fallback={<LoadingPlaceholder text="" />}>
    <mcp.MCPClientProvider appName="vikshana-graft-app" appVersion={GRAFT_BUILD_VERSION}>
      <LazyApp {...props} />
    </mcp.MCPClientProvider>
  </Suspense>
);

const AppConfig = (props: AppConfigProps) => (
  <Suspense fallback={<LoadingPlaceholder text="" />}>
    <LazyAppConfig {...props} />
  </Suspense>
);

export const plugin = new AppPlugin<{}>().setRootPage(App).addConfigPage({
  title: 'Configuration',
  icon: 'cog',
  body: AppConfig,
  id: 'configuration',
});
