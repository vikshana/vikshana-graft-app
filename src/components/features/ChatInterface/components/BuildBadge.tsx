import React from 'react';
import { GrafanaTheme2 } from '@grafana/data';
import { useStyles2 } from '@grafana/ui';
import { css } from '@emotion/css';
import { GRAFT_BUILD_DATE, GRAFT_BUILD_DISPLAY, GRAFT_BUILD_LABEL, GRAFT_BUILD_VERSION } from '../../../../buildInfo';

interface BuildBadgeProps {
  className?: string;
}

export const BuildBadge: React.FC<BuildBadgeProps> = ({ className }) => {
  const styles = useStyles2(getStyles);

  return (
    <span
      className={[styles.badge, className].filter(Boolean).join(' ')}
      data-testid="graft-build-badge"
      title={`${GRAFT_BUILD_LABEL} — version ${GRAFT_BUILD_VERSION} — built ${GRAFT_BUILD_DATE}`}
    >
      {GRAFT_BUILD_DISPLAY}
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
