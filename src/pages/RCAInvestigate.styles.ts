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
    max-width: 900px;
    width: 100%;
    margin: 0 auto;
    display: flex;
    flex-direction: column;
    gap: ${theme.spacing(2)};
  `,
  roundBadge: css`
    font-size: ${theme.typography.bodySmall.fontSize};
    background: ${theme.colors.background.secondary};
    border: 1px solid ${theme.colors.border.weak};
    padding: ${theme.spacing(0.25)} ${theme.spacing(1)};
    border-radius: ${theme.shape.radius.pill};
    color: ${theme.colors.text.secondary};
  `,
  alert: css`
    margin-bottom: 0;
  `,
  stepsPanel: css`
    background: ${theme.colors.background.secondary};
    border: 1px solid ${theme.colors.border.weak};
    border-radius: ${theme.shape.radius.default};
    padding: ${theme.spacing(2)};
  `,
  sectionTitle: css`
    font-size: ${theme.typography.h4.fontSize};
    font-weight: ${theme.typography.fontWeightMedium};
    margin: 0 0 ${theme.spacing(1)};
    display: flex;
    align-items: center;
    gap: ${theme.spacing(1)};
  `,
  stepRow: css`
    display: flex;
    align-items: center;
    gap: ${theme.spacing(1)};
    padding: ${theme.spacing(0.5)} 0;
    font-size: ${theme.typography.bodySmall.fontSize};
    &[data-status='started'] { opacity: 0.7; }
    &[data-status='complete'] { color: ${theme.colors.success.text}; }
  `,
  stepNode: css`
    flex: 1;
    text-transform: capitalize;
  `,
  stepStatus: css`
    color: ${theme.colors.text.secondary};
    font-size: ${theme.typography.bodySmall.fontSize};
  `,
  hypothesisPanel: css`
    background: ${theme.colors.background.secondary};
    border: 1px solid ${theme.colors.border.weak};
    border-left: 3px solid ${theme.colors.primary.border};
    border-radius: ${theme.shape.radius.default};
    padding: ${theme.spacing(2)};
  `,
  confidenceBadge: css`
    font-size: ${theme.typography.bodySmall.fontSize};
    padding: ${theme.spacing(0.25)} ${theme.spacing(1)};
    border-radius: ${theme.shape.radius.pill};
    font-weight: normal;
    &[data-level='high'] { background: ${theme.colors.success.transparent}; color: ${theme.colors.success.text}; }
    &[data-level='medium'] { background: ${theme.colors.warning.transparent}; color: ${theme.colors.warning.text}; }
    &[data-level='low'] { background: ${theme.colors.error.transparent}; color: ${theme.colors.error.text}; }
  `,
  hypothesisText: css`
    margin: ${theme.spacing(1)} 0;
    line-height: 1.6;
  `,
  areaRow: css`
    display: flex;
    align-items: center;
    gap: ${theme.spacing(1)};
    flex-wrap: wrap;
    margin-top: ${theme.spacing(1)};
  `,
  areaLabel: css`
    font-size: ${theme.typography.bodySmall.fontSize};
    color: ${theme.colors.text.secondary};
    flex-shrink: 0;
    display: flex;
    align-items: center;
    gap: ${theme.spacing(0.5)};
  `,
  areaChip: css`
    background: ${theme.colors.success.transparent};
    color: ${theme.colors.success.text};
    padding: ${theme.spacing(0.25)} ${theme.spacing(1)};
    border-radius: ${theme.shape.radius.pill};
    font-size: ${theme.typography.bodySmall.fontSize};
  `,
  areaChipWarn: css`
    background: ${theme.colors.warning.transparent};
    color: ${theme.colors.warning.text};
    padding: ${theme.spacing(0.25)} ${theme.spacing(1)};
    border-radius: ${theme.shape.radius.pill};
    font-size: ${theme.typography.bodySmall.fontSize};
  `,
  transcriptPanel: css`
    background: ${theme.colors.background.secondary};
    border: 1px solid ${theme.colors.border.weak};
    border-radius: ${theme.shape.radius.default};
    padding: ${theme.spacing(2)};
  `,
  turnRow: css`
    margin-bottom: ${theme.spacing(1.5)};
    &[data-role='developer'] { border-left: 2px solid ${theme.colors.primary.border}; padding-left: ${theme.spacing(1)}; }
    &[data-role='agent'] { border-left: 2px solid ${theme.colors.secondary.border}; padding-left: ${theme.spacing(1)}; }
  `,
  turnRole: css`
    font-size: ${theme.typography.bodySmall.fontSize};
    font-weight: ${theme.typography.fontWeightBold};
    color: ${theme.colors.text.secondary};
    display: flex;
    align-items: center;
    gap: ${theme.spacing(0.5)};
  `,
  turnContent: css`
    margin: ${theme.spacing(0.5)} 0 0;
    line-height: 1.5;
  `,
  reportPanel: css`
    background: ${theme.colors.background.secondary};
    border: 1px solid ${theme.colors.border.weak};
    border-left: 3px solid ${theme.colors.success.border};
    border-radius: ${theme.shape.radius.default};
    padding: ${theme.spacing(2)};
  `,
  reportContent: css`
    p { margin: ${theme.spacing(1)} 0; }
    ul { padding-left: ${theme.spacing(3)}; }
    li { margin: ${theme.spacing(0.5)} 0; }
  `,
  inputPanel: css`
    background: ${theme.colors.background.secondary};
    border: 1px solid ${theme.colors.border.weak};
    border-radius: ${theme.shape.radius.default};
    padding: ${theme.spacing(2)};
    display: flex;
    flex-direction: column;
    gap: ${theme.spacing(1.5)};
  `,
  suggestedQRow: css`
    display: flex;
    align-items: center;
    gap: ${theme.spacing(1)};
    flex-wrap: wrap;
  `,
  suggestedLabel: css`
    font-size: ${theme.typography.bodySmall.fontSize};
    color: ${theme.colors.text.secondary};
    flex-shrink: 0;
  `,
  inputRow: css`
    display: flex;
    gap: ${theme.spacing(1)};
    align-items: flex-end;
  `,
  textarea: css`
    flex: 1;
    resize: vertical;
  `,
  acceptRow: css`
    display: flex;
    justify-content: flex-end;
  `,
  startPrompt: css`
    color: ${theme.colors.text.secondary};
    text-align: center;
    padding: ${theme.spacing(4)};
  `,
});
