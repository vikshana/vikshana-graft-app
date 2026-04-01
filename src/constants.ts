import pluginJson from './plugin.json';

export const PLUGIN_BASE_URL = `/a/${pluginJson.id}`;

export enum ROUTES {
  One = 'one',
  Two = 'two',
  Three = 'three',
  Four = 'four',
  // RCA routes
  Rca = 'rca',
  RcaRuns = 'rca/runs',
  RcaInvestigate = 'rca/investigate',
}
