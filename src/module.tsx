import React, { Suspense, useEffect } from 'react';
import { AppPlugin, type AppRootProps } from '@grafana/data';
import { LoadingPlaceholder } from '@grafana/ui';
import type { AppConfigProps } from './components/features/AppConfig/AppConfig';
import { lazyWithChunkRetry } from './utils/lazyWithChunkRetry';
import { checkPluginBuildVersion } from './utils/checkPluginBuildVersion';

const LazyApp = lazyWithChunkRetry(
    () => import(/* webpackChunkName: "graft-routes" */ './components/features/App/App'),
    'graft-routes'
);
const LazyAppConfig = lazyWithChunkRetry(
    () => import(/* webpackChunkName: "graft-config" */ './components/features/AppConfig/AppConfig'),
    'graft-config'
);

import { mcp } from '@grafana/llm';
import { GRAFT_BUILD_VERSION } from './buildInfo';
// Eager import so chatHistoryService global singleton exists before lazy route chunks load
import './services/chatHistory';
// Eager import so rename routing is in module.js, not only the lazy ChatInterface chunk
import './services/renameLlmGuard';

const App = (props: AppRootProps) => {
  useEffect(() => {
    void checkPluginBuildVersion();
  }, []);

  return (
  <Suspense fallback={<LoadingPlaceholder text="" />}>
    <mcp.MCPClientProvider appName="vikshana-graft-app" appVersion={GRAFT_BUILD_VERSION}>
      <LazyApp {...props} />
    </mcp.MCPClientProvider>
  </Suspense>
  );
};

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
