import pluginJson from './plugin.json';

export const PLUGIN_BASE_URL = `/a/${pluginJson.id}`;

export enum ROUTES {
  Rca = 'rca',
  RcaRuns = 'rca/runs',
  RcaInvestigate = 'rca/investigate',
}
