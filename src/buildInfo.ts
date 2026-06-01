/**
 * Visible in the Graft UI so you can confirm the ElectraMet custom fork is deployed.
 * Version should match package.json; date is set when you run npm run build.
 */
export const GRAFT_BUILD_LABEL = 'ElectraMet custom';
export const GRAFT_BUILD_VERSION = '0.1.1-electramet';
export const GRAFT_BUILD_DATE =
  typeof __GRAFT_BUILD_DATE__ !== 'undefined' ? __GRAFT_BUILD_DATE__ : 'dev';

export const GRAFT_BUILD_DISPLAY = `${GRAFT_BUILD_LABEL} · v${GRAFT_BUILD_VERSION} · ${GRAFT_BUILD_DATE}`;
