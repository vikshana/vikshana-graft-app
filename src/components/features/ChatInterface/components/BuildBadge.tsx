import React, { useEffect, useState } from 'react';
import { GrafanaTheme2 } from '@grafana/data';
import { useStyles2 } from '@grafana/ui';
import { css } from '@emotion/css';
import {
  GRAFT_BUILD_DATE,
  GRAFT_BUILD_DISPLAY,
  GRAFT_BUILD_INFO_URL,
  GRAFT_BUILD_LABEL,
  GRAFT_BUILD_NUMBER,
  GRAFT_BUILD_VERSION,
  formatBuildDisplay,
} from '../../../../buildInfo';

interface BuildBadgeProps {
  className?: string;
}

interface BuildInfoFile {
  version: string;
  build: number;
}

export const BuildBadge: React.FC<BuildBadgeProps> = ({ className }) => {
  const styles = useStyles2(getStyles);
  const [display, setDisplay] = useState(GRAFT_BUILD_DISPLAY);
  const [title, setTitle] = useState(
    `${GRAFT_BUILD_LABEL} — version ${GRAFT_BUILD_VERSION} — build ${GRAFT_BUILD_NUMBER} — ${GRAFT_BUILD_DATE}`
  );

  // Load build from build-info.json (not cached like old JS chunks can be)
  useEffect(() => {
    const url = `${GRAFT_BUILD_INFO_URL}?_=${Date.now()}`;
    fetch(url, { cache: 'no-store' })
      .then((res) => (res.ok ? res.json() : Promise.reject(new Error(String(res.status)))))
      .then((info: BuildInfoFile) => {
        if (!info?.version || info.build == null) {
          return;
        }
        const text = formatBuildDisplay(info.version, info.build);
        setDisplay(text);
        setTitle(`${GRAFT_BUILD_LABEL} — version ${info.version} — build ${info.build} — ${GRAFT_BUILD_DATE}`);
      })
      .catch(() => {
        // Keep bundled fallback if fetch fails
      });
  }, []);

  return (
    <span
      className={[styles.badge, className].filter(Boolean).join(' ')}
      data-testid="graft-build-badge"
      title={title}
    >
      {display}
    </span>
  );
};

const getStyles = (theme: GrafanaTheme2) => ({
  badge: css`
    display: inline-block;
    font-size: 11px;
    line-height: 1.3;
    color: ${theme.colors.text.secondary};
    background: ${theme.colors.background.secondary};
    border: 1px solid ${theme.colors.border.weak};
    border-radius: 4px;
    padding: 2px 8px;
    font-family: ${theme.typography.fontFamilyMonospace};
    user-select: text;
  `,
});
