import type { Configuration, ExternalItemFunctionData } from 'webpack';

type ExternalsType = Configuration['externals'];

export const externals: ExternalsType = [
  // Required for dynamic publicPath resolution
  { 'amd-module': 'module' },
  'lodash',
  'jquery',
  'moment',
  'slate',
  'emotion',
  '@emotion/react',
  '@emotion/css',
  'prismjs',
  'slate-plain-serializer',
  '@grafana/slate-react',
  'react',
  'react-dom',
  // Sub-path exports used by the React JSX transform. Without these, the JSX
  // runtime from the local node_modules is bundled inline (React 18 behaviour),
  // which crashes when Grafana is running React 19 (e.g. grafana-enterprise@13.1+).
  'react/jsx-runtime',
  'react/jsx-dev-runtime',
  'react-redux',
  'redux',
  'rxjs',
  'i18next',
  'react-router',
  'd3',
  'angular',
  /^@grafana\/ui/i,
  /^@grafana\/runtime/i,
  /^@grafana\/data/i,

  // Mark legacy SDK imports as external if their name starts with the "grafana/" prefix
  ({ request }: ExternalItemFunctionData, callback: (error?: Error, result?: string) => void) => {
    const prefix = 'grafana/';
    const hasPrefix = (request: string) => request.indexOf(prefix) === 0;
    const stripPrefix = (request: string) => request.slice(prefix.length);

    if (request && hasPrefix(request)) {
      return callback(undefined, stripPrefix(request));
    }

    callback();
  },
];
