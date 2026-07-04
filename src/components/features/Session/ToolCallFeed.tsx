import React from 'react';
import { Icon, Spinner, Stack } from '@grafana/ui';
import { css } from '@emotion/css';
import { useStyles2 } from '@grafana/ui';

import type { ToolCallStep } from '../../../types/session.types';

interface Props {
  steps: ToolCallStep[];
  onDrillDown?: (handle: string) => void;
}

/**
 * ToolCallFeed — compact list of tool calls with per-call status indicators.
 *
 * Each row shows the tool name, truncated args, and a status icon:
 *   spinner  = in-progress
 *   check    = completed successfully
 *   x        = denied by a guard
 *
 * Clicking a completed row that has a drill_down_handle notifies the parent
 * so it can open the EvidencePanel for that result.
 */
export function ToolCallFeed({ steps, onDrillDown }: Props) {
  const styles = useStyles2(getStyles);

  if (steps.length === 0) {
    return null;
  }

  return (
    <div data-testid="tool-call-feed" className={styles.container}>
      {steps.map((step) => (
        <div
          key={step.id}
          className={[
            styles.row,
            step.drillDownHandle && step.status === 'done' ? styles.clickable : '',
          ]
            .filter(Boolean)
            .join(' ')}
          onClick={() => {
            if (step.drillDownHandle && step.status === 'done' && onDrillDown) {
              onDrillDown(step.drillDownHandle);
            }
          }}
        >
          <div className={styles.icon}>
            {step.status === 'running' && <Spinner size="sm" />}
            {step.status === 'done' && (
              <Icon name="check-circle" className={styles.iconDone} />
            )}
            {step.status === 'denied' && (
              <Icon name="times-circle" className={styles.iconDenied} />
            )}
          </div>
          <div className={styles.content}>
            <span className={styles.toolName}>{step.tool}</span>
            {step.resultPreview && (
              <span className={styles.preview}>{step.resultPreview.slice(0, 80)}</span>
            )}
          </div>
          {step.drillDownHandle && step.status === 'done' && (
            <Icon name="eye" className={styles.drillDownIcon} />
          )}
        </div>
      ))}
    </div>
  );
}

const getStyles = () => ({
  container: css`
    display: flex;
    flex-direction: column;
    gap: 4px;
    padding: 8px 0;
  `,
  row: css`
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 4px 8px;
    border-radius: 4px;
    font-size: 12px;
  `,
  clickable: css`
    cursor: pointer;
    &:hover {
      background: rgba(255, 255, 255, 0.05);
    }
  `,
  icon: css`
    width: 16px;
    flex-shrink: 0;
  `,
  iconDone: css`
    color: #73bf69;
  `,
  iconDenied: css`
    color: #f2495c;
  `,
  content: css`
    display: flex;
    flex-direction: column;
    flex: 1;
    min-width: 0;
  `,
  toolName: css`
    font-weight: 500;
  `,
  preview: css`
    color: #9fa7b3;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  `,
  drillDownIcon: css`
    color: #6e9fff;
    flex-shrink: 0;
  `,
});
