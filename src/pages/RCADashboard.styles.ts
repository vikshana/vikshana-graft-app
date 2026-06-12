import { css } from '@emotion/css';
import { GrafanaTheme2 } from '@grafana/data';

export const getStyles = (theme: GrafanaTheme2) => ({
  container: css`
    display: flex;
    flex-direction: column;
    height: 100%;
    background: ${theme.colors.background.primary};
  `,
  content: css`
    flex: 1;
    overflow-y: auto;
    padding: ${theme.spacing(3)};
    max-width: 1200px;
    width: 100%;
    margin: 0 auto;
  `,
  subHeading: css`
    margin-bottom: ${theme.spacing(2)};
    font-size: ${theme.typography.h4.fontSize};
    font-weight: ${theme.typography.fontWeightMedium};
  `,
  statsGrid: css`
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(160px, 1fr));
    gap: ${theme.spacing(2)};
    margin-bottom: ${theme.spacing(4)};
  `,
  statCard: css`
    background: ${theme.colors.background.secondary};
    border: 1px solid ${theme.colors.border.weak};
    border-radius: ${theme.shape.radius.default};
    padding: ${theme.spacing(2)};
    text-align: center;
  `,
  statCardHighlight: css`
    background: ${theme.colors.background.secondary};
    border: 1px solid ${theme.colors.warning.border};
    border-radius: ${theme.shape.radius.default};
    padding: ${theme.spacing(2)};
    text-align: center;
  `,
  statValue: css`
    font-size: ${theme.typography.h2.fontSize};
    font-weight: ${theme.typography.fontWeightBold};
  `,
  statLabel: css`
    font-size: ${theme.typography.bodySmall.fontSize};
    color: ${theme.colors.text.secondary};
    margin-top: ${theme.spacing(0.5)};
  `,
  section: css`
    margin-bottom: ${theme.spacing(4)};
  `,
  confidenceRow: css`
    display: grid;
    grid-template-columns: repeat(4, 1fr);
    gap: ${theme.spacing(2)};
  `,
  confidenceBadge: css`
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    padding: ${theme.spacing(2)};
    border: 2px solid;
    border-radius: ${theme.shape.radius.default};
    background: ${theme.colors.background.secondary};
    &[data-level='high'] { border-color: ${theme.colors.success.border}; }
    &[data-level='medium'] { border-color: ${theme.colors.warning.border}; }
    &[data-level='low'] { border-color: ${theme.colors.error.border}; }
    &[data-level='unset'] { border-color: ${theme.colors.text.disabled}; }
  `,
  confidenceCount: css`
    font-size: ${theme.typography.h3.fontSize};
    font-weight: ${theme.typography.fontWeightBold};
  `,
  confidenceLabel: css`
    font-size: ${theme.typography.bodySmall.fontSize};
    color: ${theme.colors.text.secondary};
  `,
  table: css`
    width: 100%;
    border-collapse: collapse;
    border: 1px solid ${theme.colors.border.weak};
    border-radius: ${theme.shape.radius.default};
    overflow: hidden;
    th, td {
      text-align: left;
      padding: ${theme.spacing(1.5)};
      border-bottom: 1px solid ${theme.colors.border.weak};
    }
    th {
      font-weight: ${theme.typography.fontWeightBold};
      color: ${theme.colors.text.secondary};
      background: ${theme.colors.background.secondary};
    }
    tr:last-child td {
      border-bottom: none;
    }
    tr {
      cursor: pointer;
    }
    tr:hover td {
      background: ${theme.colors.action.hover};
    }
  `,
  statusBadge: css`
    padding: ${theme.spacing(0.25)} ${theme.spacing(1)};
    border-radius: ${theme.shape.radius.pill};
    font-size: ${theme.typography.bodySmall.fontSize};
    background: ${theme.colors.background.secondary};
    &[data-status='complete'] { background: ${theme.colors.success.transparent}; color: ${theme.colors.success.text}; }
    &[data-status='failed'] { background: ${theme.colors.error.transparent}; color: ${theme.colors.error.text}; }
    &[data-status='investigating'] { background: ${theme.colors.warning.transparent}; color: ${theme.colors.warning.text}; }
  `,
  investigateBtn: css`
    background: none;
    border: none;
    color: ${theme.colors.text.link};
    cursor: pointer;
    padding: 0;
    font-size: ${theme.typography.bodySmall.fontSize};
    &:hover { text-decoration: underline; }
  `,
  loadingWrapper: css`
    padding: ${theme.spacing(4)} 0;
  `,
  errorWrapper: css`
    margin-bottom: ${theme.spacing(3)};
  `,
});
