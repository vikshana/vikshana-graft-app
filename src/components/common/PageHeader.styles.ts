import { css } from '@emotion/css';
import { GrafanaTheme2 } from '@grafana/data';

export const getStyles = (theme: GrafanaTheme2) => ({
  header: css`
    display: flex;
    justify-content: space-between;
    align-items: center;
    padding: ${theme.spacing(2)};
    border-bottom: 1px solid ${theme.colors.border.weak};
    background: ${theme.colors.background.primary};
    position: sticky;
    top: 40px;
    z-index: 10;
  `,
  left: css`
    display: flex;
    align-items: center;
    flex: 1;
  `,
  center: css`
    position: absolute;
    left: 50%;
    transform: translateX(-50%);
    white-space: nowrap;
  `,
  title: css`
    font-size: ${theme.typography.h4.fontSize};
    font-weight: ${theme.typography.fontWeightMedium};
    color: ${theme.colors.text.primary};
    margin: 0;
  `,
  right: css`
    display: flex;
    align-items: center;
    justify-content: flex-end;
    gap: ${theme.spacing(1)};
    flex: 1;
  `,
});
