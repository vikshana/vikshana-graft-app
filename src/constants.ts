import pluginJson from './plugin.json';

export const PLUGIN_BASE_URL = `/a/${pluginJson.id}`;

export enum ROUTES {
  Rca = 'rca',
  RcaRuns = 'rca/runs',
  RcaInvestigate = 'rca/investigate',
  // Phase 2: harness session routes (Option A — alongside existing RCA pages)
  Sessions = 'sessions',
  SessionDetail = 'sessions/:sessionId',
}
