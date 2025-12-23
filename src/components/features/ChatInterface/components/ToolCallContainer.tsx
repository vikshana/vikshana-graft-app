import React, { useState, useMemo, useRef, useEffect } from 'react';
import { GrafanaTheme2 } from '@grafana/data';
import { useStyles2, Icon } from '@grafana/ui';
import { css } from '@emotion/css';
import { ToolExecution } from '../../../../services/llm';

interface ToolCallContainerProps {
    toolExecutions: ToolExecution[];
    theme: GrafanaTheme2;
}

// Compute error indices from tool executions
const getErrorIndices = (toolExecutions: ToolExecution[]): Set<number> => {
    const errorIndices = new Set<number>();
    toolExecutions.forEach((exec, index) => {
        if (exec.status === 'error') {
            errorIndices.add(index);
        }
    });
    return errorIndices;
};

export const ToolCallContainer: React.FC<ToolCallContainerProps> = ({ toolExecutions, theme }) => {
    // Track which items user has manually collapsed
    const manuallyCollapsed = useRef<Set<number>>(new Set());
    const styles = useStyles2(getStyles);

    // Compute expanded items: all errors minus manually collapsed
    const errorIndices = useMemo(() => getErrorIndices(toolExecutions), [toolExecutions]);
    const [expandedItems, setExpandedItems] = useState<Set<number>>(() => errorIndices);

    // Sync expanded items when new errors appear
    const prevErrorIndicesRef = useRef<Set<number>>(errorIndices);
    useEffect(() => {
        const prevErrors = prevErrorIndicesRef.current;
        const newErrors = new Set<number>();
        errorIndices.forEach(idx => {
            if (!prevErrors.has(idx)) {
                newErrors.add(idx);
            }
        });
        if (newErrors.size > 0) {
            setExpandedItems(prev => {
                const next = new Set(prev);
                newErrors.forEach(idx => {
                    if (!manuallyCollapsed.current.has(idx)) {
                        next.add(idx);
                    }
                });
                return next;
            });
        }
        prevErrorIndicesRef.current = errorIndices;
    }, [errorIndices]);

    const toggleExpand = (index: number) => {
        setExpandedItems(prev => {
            const next = new Set(prev);
            if (next.has(index)) {
                next.delete(index);
            } else {
                next.add(index);
            }
            return next;
        });
    };

    if (!toolExecutions || toolExecutions.length === 0) {
        return null;
    }

    return (
        <div className={styles.toolCallsWrapper}>
            {toolExecutions.map((exec, index) => {
                const isExpanded = expandedItems.has(index);
                const hasError = exec.status === 'error';

                return (
                    <div key={index} className={styles.toolCallContainer}>
                        <div
                            className={styles.toolCallHeader}
                            onClick={() => hasError && toggleExpand(index)}
                            style={{ cursor: hasError ? 'pointer' : 'default' }}
                        >
                            <div className={styles.toolCallStatus}>
                                {exec.status === 'pending' && (
                                    <Icon name="fa fa-spinner" className={styles.toolCallSpinner} />
                                )}
                                {exec.status === 'success' && (
                                    <span className={styles.toolCallSuccess}>✓</span>
                                )}
                                {exec.status === 'error' && (
                                    <span className={styles.toolCallError}>✗</span>
                                )}
                            </div>
                            <span className={styles.toolCallName}>{exec.name}</span>
                            {hasError && (
                                <Icon name={isExpanded ? 'angle-down' : 'angle-right'} size="sm" />
                            )}
                        </div>
                        {hasError && isExpanded && exec.error && (
                            <div className={styles.toolCallErrorDetails}>
                                {exec.error}
                            </div>
                        )}
                    </div>
                );
            })}
        </div>
    );
};

const getStyles = (theme: GrafanaTheme2) => ({
    toolCallsWrapper: css`
    display: flex;
    flex-direction: column;
    gap: 8px;
    margin-bottom: 12px;
    width: 100%;
  `,
    toolCallContainer: css`
    border: 1px solid ${theme.colors.border.weak};
    border-radius: 8px;
    background: ${theme.colors.background.primary};
    overflow: hidden;
  `,
    toolCallHeader: css`
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 8px 12px;
    font-size: 13px;
    color: ${theme.colors.text.primary};
    background: ${theme.colors.background.primary};
    
    &:hover {
      background: ${theme.colors.background.secondary};
    }
  `,
    toolCallStatus: css`
    display: flex;
    align-items: center;
    justify-content: center;
    width: 16px;
    height: 16px;
  `,
    toolCallSpinner: css`
    color: ${theme.colors.primary.text};
    font-size: 14px;
    animation: spin 1s linear infinite;
    @keyframes spin {
      0% { transform: rotate(0deg); }
      100% { transform: rotate(360deg); }
    }
  `,
    toolCallSuccess: css`
    color: ${theme.colors.success.text};
    font-weight: bold;
    font-size: 14px;
  `,
    toolCallError: css`
    color: ${theme.colors.error.text};
    font-weight: bold;
    font-size: 14px;
  `,
    toolCallName: css`
    font-family: ${theme.typography.fontFamilyMonospace};
    flex: 1;
  `,
    toolCallErrorDetails: css`
    padding: 8px 12px;
    border-top: 1px solid ${theme.colors.border.weak};
    background: ${theme.colors.background.secondary};
    color: ${theme.colors.error.text};
    font-size: 12px;
    font-family: ${theme.typography.fontFamilyMonospace};
    white-space: pre-wrap;
    word-break: break-word;
  `,
});
