/**
 * Shim for react/jsx-runtime — bundled inline but delegates to the React
 * object that Grafana exposes as a SystemJS/AMD global. This ensures:
 *
 *  - Grafana 11.x (React 17/18, SystemJS): uses React.createElement
 *  - Grafana 12.x (React 18, native ESM): uses React.createElement
 *  - Grafana 13.1+ (React 19, native ESM): uses React.createElement
 *
 * Without this shim the automatic JSX transform would either:
 *   a) Bundle react/jsx-runtime from node_modules (React 18) inline →
 *      crashes on Grafana 13.1+ because ReactCurrentOwner was removed in R19
 *   b) Mark react/jsx-runtime as an AMD external → crashes on Grafana 11.x
 *      because SystemJS tries to load it as a URL and gets a 404
 *
 * IMPORTANT — the jsx-runtime API is NOT the same as React.createElement:
 *
 *   jsx(type, props, key)          — key is a dedicated 3rd positional arg
 *   React.createElement(type, props, ...children) — 3rd+ args are children
 *
 * Libraries like hast-util-to-jsx-runtime (used by react-markdown) call
 * jsx('p', { children: 'text' }, 'p-0') where 'p-0' is the reconciliation
 * key. Aliasing jsx directly to React.createElement causes 'p-0' to be
 * treated as a child, overwriting the real children and rendering the key
 * string as visible text content.
 *
 * This wrapper correctly bridges the two APIs:
 *   1. Moves `key` from the 3rd positional arg into `props.key` (the only
 *      mechanism createElement recognises for setting the React element key).
 *   2. Extracts `children` from props and spreads them as variadic args so
 *      that createElement receives them in the expected position.
 */
import * as React from 'react';

export const Fragment = React.Fragment;

export function jsx(type: React.ElementType, props: Record<string, unknown>, key?: React.Key): React.ReactElement {
  const { children, ...rest } = props ?? {};
  if (key !== undefined) {
    (rest as Record<string, unknown>).key = key;
  }
  if (children === undefined) {
    return React.createElement(type, rest as React.Attributes);
  }
  if (Array.isArray(children)) {
    return React.createElement(type, rest as React.Attributes, ...(children as React.ReactNode[]));
  }
  return React.createElement(type, rest as React.Attributes, children as React.ReactNode);
}

export const jsxs = jsx;
export const jsxDEV = jsx;
