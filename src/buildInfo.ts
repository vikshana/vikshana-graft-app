import buildMeta from '../electramet-build.json';

/**
 * Visible in the Graft UI so you can confirm the ElectraMet custom fork is deployed.
 * Version/build are injected at compile time via webpack DefinePlugin.
 * BuildBadge also loads dist/build-info.json at runtime (avoids stale cached JS chunks).
 */
export const GRAFT_BUILD_LABEL = 'ElectraMet custom';
export const GRAFT_BUILD_VERSION =
  typeof __GRAFT_BUILD_VERSION__ !== 'undefined' ? __GRAFT_BUILD_VERSION__ : buildMeta.version;
export const GRAFT_BUILD_NUMBER =
  typeof __GRAFT_BUILD_NUMBER__ !== 'undefined'
    ? Number(__GRAFT_BUILD_NUMBER__)
    : buildMeta.build;
export const GRAFT_BUILD_DATE =
  typeof __GRAFT_BUILD_DATE__ !== 'undefined' ? __GRAFT_BUILD_DATE__ : 'dev';

export const GRAFT_BUILD_DISPLAY = `${GRAFT_BUILD_LABEL} · v${GRAFT_BUILD_VERSION} · build ${GRAFT_BUILD_NUMBER} · ${GRAFT_BUILD_DATE}`;

export const GRAFT_BUILD_INFO_URL = 'public/plugins/vikshana-graft-app/build-info.json';

export function formatBuildDisplay(version: string, build: number, date = GRAFT_BUILD_DATE): string {
  return `${GRAFT_BUILD_LABEL} · v${version} · build ${build} · ${date}`;
}
