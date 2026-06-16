import React, { useState, useRef, useEffect, useMemo } from 'react';
import { GrafanaTheme2 } from '@grafana/data';
import { useStyles2, Icon } from '@grafana/ui';
import { css } from '@emotion/css';
import type { StepToolExecutions, ToolExecution } from '../../../../types/llm.types';

interface StepToolCallContainerProps {
    stepGroups: StepToolExecutions[];
}

/** Resolves the step-level status icon and label. */
function stepStatusIcon(group: StepToolExecutions): { icon: React.ReactNode; label: string } {
    if (group.status === 'running') {
        return { icon: '⏳', label: 'running' };
    }
    const hasError = group.toolExecutions.some(t => t.status === 'error');
    if (hasError || group.status === 'error') {
        return { icon: '✗', label: 'error' };
    }
    return { icon: '✓', label: 'done' };
}

/** Renders a single tool execution row — identical appearance to ToolCallContainer rows. */
const ToolRow: React.FC<{
    exec: ToolExecution;
    index: number;
    isExpanded: boolean;
    onToggle: (index: number) => void;
    styles: ReturnType<typeof getStyles>;
}> = ({ exec, index, isExpanded, onToggle, styles }) => {
    const hasError = exec.status === 'error';
    return (
        <div className={styles.toolCallContainer}>
            <div
                className={styles.toolCallHeader}
                onClick={() => hasError && onToggle(index)}
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
};

/** Renders one step group — collapsible header + tool rows. */
const StepGroup: React.FC<{
    group: StepToolExecutions;
    styles: ReturnType<typeof getStyles>;
}> = ({ group, styles }) => {
    const [isExpanded, setIsExpanded] = useState(true);
    const [expandedTools, setExpandedTools] = useState<Set<number>>(new Set());
    const prevStatus = useRef<StepToolExecutions['status']>(group.status);
    const prevErrorCount = useRef(0);

    // Collapse the group automatically when the step transitions to done/error.
    // A user who manually re-opened it won't be affected by subsequent status
    // updates because the collapse only fires on the running → done/error edge.
    useEffect(() => {
        if (prevStatus.current === 'running' && group.status !== 'running') {
            setIsExpanded(false);
        }
        prevStatus.current = group.status;
    }, [group.status]);

    // Auto-expand error tool rows when they first appear
    const errorIndices = useMemo(
        () => new Set(group.toolExecutions.map((t, i) => t.status === 'error' ? i : -1).filter(i => i !== -1)),
        [group.toolExecutions]
    );
    useEffect(() => {
        if (errorIndices.size > prevErrorCount.current) {
            setExpandedTools(prev => {
                const next = new Set(prev);
                errorIndices.forEach(i => next.add(i));
                return next;
            });
        }
        prevErrorCount.current = errorIndices.size;
    }, [errorIndices]);

    const toggleTool = (index: number) => {
        setExpandedTools(prev => {
            const next = new Set(prev);
            next.has(index) ? next.delete(index) : next.add(index);
            return next;
        });
    };

    const { icon, label } = stepStatusIcon(group);

    return (
        <div className={styles.stepGroup}>
            {/* Step header */}
            <div
                className={`${styles.stepHeader} ${styles[`stepHeader_${label}` as keyof ReturnType<typeof getStyles>] ?? ''}`}
                onClick={() => setIsExpanded(e => !e)}
            >
                <Icon name={isExpanded ? 'angle-down' : 'angle-right'} />
                <span className={styles.stepStatusIcon}>{icon}</span>
                <span className={styles.stepDescription}>{group.stepDescription}</span>
                {group.toolExecutions.length > 0 && (
                    <span className={styles.stepToolCount}>
                        {group.toolExecutions.length} tool{group.toolExecutions.length !== 1 ? 's' : ''}
                    </span>
                )}
            </div>

            {/* Tool rows — only shown when step group is expanded */}
            {isExpanded && group.toolExecutions.length > 0 && (
                <div className={styles.toolList}>
                    {group.toolExecutions.map((exec, idx) => (
                        <ToolRow
                            key={idx}
                            exec={exec}
                            index={idx}
                            isExpanded={expandedTools.has(idx)}
                            onToggle={toggleTool}
                            styles={styles}
                        />
                    ))}
                </div>
            )}
        </div>
    );
};

/**
 * Renders tool calls grouped by specialist step.
 * Used in the multi-agent orchestrator path where parallel specialists
 * each emit independent tool execution arrays that must not overwrite each other.
 */
export const StepToolCallContainer: React.FC<StepToolCallContainerProps> = ({ stepGroups }) => {
    const styles = useStyles2(getStyles);

    if (!stepGroups || stepGroups.length === 0) {
        return null;
    }

    return (
        <div className={styles.wrapper}>
            {stepGroups.map(group => (
                <StepGroup key={group.stepId} group={group} styles={styles} />
            ))}
        </div>
    );
};

const getStyles = (theme: GrafanaTheme2) => ({
    wrapper: css`
        display: flex;
        flex-direction: column;
        gap: ${theme.spacing(1)};
        margin-bottom: ${theme.spacing(1.5)};
        width: 100%;
    `,
    stepGroup: css`
        border: 1px solid ${theme.colors.border.weak};
        border-radius: 8px;
        background: ${theme.colors.background.primary};
        overflow: hidden;
    `,
    stepHeader: css`
        display: flex;
        align-items: center;
        gap: ${theme.spacing(1)};
        padding: ${theme.spacing(1)} ${theme.spacing(1.5)};
        cursor: pointer;
        user-select: none;
        background: ${theme.colors.background.secondary};
        &:hover {
            background: ${theme.colors.action.hover};
        }
    `,
    stepHeader_running: css``,
    stepHeader_done: css``,
    stepHeader_error: css`
        border-left: 3px solid ${theme.colors.error.border};
    `,
    stepStatusIcon: css`
        font-size: 12px;
        width: 16px;
        text-align: center;
        flex-shrink: 0;
    `,
    stepDescription: css`
        font-size: ${theme.typography.bodySmall.fontSize};
        color: ${theme.colors.text.primary};
        flex: 1;
    `,
    stepToolCount: css`
        font-size: ${theme.typography.bodySmall.fontSize};
        color: ${theme.colors.text.secondary};
        flex-shrink: 0;
    `,
    toolList: css`
        display: flex;
        flex-direction: column;
        gap: 0;
        padding: ${theme.spacing(0.5)} ${theme.spacing(1)};
        background: ${theme.colors.background.primary};
    `,
    // Tool row styles — mirrors ToolCallContainer exactly
    toolCallContainer: css`
        border: 1px solid ${theme.colors.border.weak};
        border-radius: 6px;
        background: ${theme.colors.background.primary};
        overflow: hidden;
        margin-bottom: ${theme.spacing(0.5)};
    `,
    toolCallHeader: css`
        display: flex;
        align-items: center;
        gap: 8px;
        padding: 6px 10px;
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
