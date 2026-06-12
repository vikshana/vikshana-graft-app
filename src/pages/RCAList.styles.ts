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
    max-width: 1400px;
    width: 100%;
    margin: 0 auto;
  `,
  filterBar: css`
    display: flex;
    gap: ${theme.spacing(2)};
    margin-bottom: ${theme.spacing(3)};
    flex-wrap: wrap;
    align-items: center;
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
  emptyCell: css`
    text-align: center;
    padding: ${theme.spacing(4)};
    color: ${theme.colors.text.secondary};
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
  pagination: css`
    display: flex;
    align-items: center;
    gap: ${theme.spacing(2)};
    margin-top: ${theme.spacing(3)};
    justify-content: center;
  `,
  pageInfo: css`
    color: ${theme.colors.text.secondary};
    font-size: ${theme.typography.bodySmall.fontSize};
  `,
  errorWrapper: css`
    margin-bottom: ${theme.spacing(3)};
  `,
});
