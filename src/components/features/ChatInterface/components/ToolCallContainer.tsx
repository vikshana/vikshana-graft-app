import React, { useState, useMemo, useRef, useEffect } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { GrafanaTheme2 } from '@grafana/data';
import { useStyles2, Icon } from '@grafana/ui';
import { css } from '@emotion/css';
import { ToolExecution } from '../../../../services/llm';

interface ToolCallContainerProps {
    toolExecutions: ToolExecution[];
    theme: GrafanaTheme2;
}

// Expand errors and dashboard reference tables by default
const getInitiallyExpandedIndices = (toolExecutions: ToolExecution[]): Set<number> => {
    const expanded = new Set<number>();
    toolExecutions.forEach((exec, index) => {
        if (exec.status === 'error' || exec.userReference) {
            expanded.add(index);
        }
    });
    return expanded;
};

export const ToolCallContainer: React.FC<ToolCallContainerProps> = ({ toolExecutions, theme }) => {
    // Track which items user has manually collapsed
    const manuallyCollapsed = useRef<Set<number>>(new Set());
    const styles = useStyles2(getStyles);

    const autoExpandIndices = useMemo(
        () => getInitiallyExpandedIndices(toolExecutions),
        [toolExecutions]
    );
    const [expandedItems, setExpandedItems] = useState<Set<number>>(() => autoExpandIndices);

    const prevAutoExpandRef = useRef<Set<number>>(autoExpandIndices);
    useEffect(() => {
        const prev = prevAutoExpandRef.current;
        const newlyExpanded = new Set<number>();
        autoExpandIndices.forEach((idx) => {
            if (!prev.has(idx)) {
                newlyExpanded.add(idx);
            }
        });
        if (newlyExpanded.size > 0) {
            setExpandedItems((prevExpanded) => {
                const next = new Set(prevExpanded);
                newlyExpanded.forEach((idx) => {
                    if (!manuallyCollapsed.current.has(idx)) {
                        next.add(idx);
                    }
                });
                return next;
            });
        }
        prevAutoExpandRef.current = autoExpandIndices;
    }, [autoExpandIndices]);

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
                const hasDetails = hasError || Boolean(exec.summary) || Boolean(exec.userReference);

                return (
                    <div key={index} className={styles.toolCallContainer}>
                        <div
                            className={styles.toolCallHeader}
                            onClick={() => hasDetails && toggleExpand(index)}
                            style={{ cursor: hasDetails ? 'pointer' : 'default' }}
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
                            <span className={styles.toolCallName}>
                                {exec.name}
                                {exec.summary && exec.status === 'success' && (
                                    <span className={styles.toolCallSummary}> — {exec.summary}</span>
                                )}
                            </span>
                            {hasDetails && (
                                <Icon name={isExpanded ? 'angle-down' : 'angle-right'} size="sm" />
                            )}
                        </div>
                        {hasError && isExpanded && exec.error && (
                            <div className={styles.toolCallErrorDetails}>
                                {exec.error}
                            </div>
                        )}
                        {!hasError && exec.summary && isExpanded && !exec.userReference && (
                            <div className={styles.toolCallSuccessDetails}>
                                {exec.summary}
                            </div>
                        )}
                        {exec.userReference && isExpanded && (
                            <div className={styles.toolCallReference}>
                                <ReactMarkdown remarkPlugins={[remarkGfm]}>{exec.userReference}</ReactMarkdown>
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
    toolCallSummary: css`
    color: ${theme.colors.text.secondary};
    font-weight: normal;
  `,
    toolCallSuccessDetails: css`
    padding: 8px 12px;
    border-top: 1px solid ${theme.colors.border.weak};
    background: ${theme.colors.background.secondary};
    color: ${theme.colors.success.text};
    font-size: 12px;
    font-family: ${theme.typography.fontFamilyMonospace};
  `,
    toolCallReference: css`
    padding: 10px 12px;
    border-top: 1px solid ${theme.colors.border.weak};
    background: ${theme.colors.background.secondary};
    font-size: 12px;
    color: ${theme.colors.text.primary};
    overflow-x: auto;

    table {
      border-collapse: collapse;
      margin: 8px 0;
      font-size: 12px;
    }
    th,
    td {
      border: 1px solid ${theme.colors.border.medium};
      padding: 4px 8px;
    }
    p {
      margin: 4px 0;
    }
  `,
});
