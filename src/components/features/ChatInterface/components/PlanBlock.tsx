import React, { useState } from 'react';
import { GrafanaTheme2 } from '@grafana/data';
import { useStyles2, Icon } from '@grafana/ui';
import { css } from '@emotion/css';
import type { AgentPlanStep } from '../../../../types/llm.types';

interface PlanBlockProps {
    reasoning: string;
    steps: AgentPlanStep[];
    /** True while the orchestrator is still executing specialists */
    isStreaming: boolean;
}

export const PlanBlock: React.FC<PlanBlockProps> = ({ reasoning, steps, isStreaming }) => {
    const [isExpanded, setIsExpanded] = useState(false);
    const styles = useStyles2(getStyles);

    return (
        <div className={styles.planBlockWrapper}>
            <div
                className={styles.planHeader}
                onClick={() => setIsExpanded(!isExpanded)}
            >
                <Icon name={isExpanded ? 'angle-down' : 'angle-right'} />
                <span className={styles.planLabel}>
                    {isStreaming ? 'Planning\u2026' : 'View plan'}
                </span>
            </div>

            {isExpanded && (
                <div className={styles.planContent}>
                    <p className={styles.planReasoning}>{reasoning}</p>
                    <ol className={styles.planStepList}>
                        {steps.map((step) => (
                            <li key={step.id} className={styles.planStepItem}>
                                <span className={styles.planStepDescription}>{step.description}</span>
                                {step.toolCategories.length > 0 && (
                                    <span className={styles.planStepCategories}>
                                        {step.toolCategories.map((cat) => (
                                            <span key={cat} className={styles.planCategoryBadge}>
                                                {cat}
                                            </span>
                                        ))}
                                    </span>
                                )}
                            </li>
                        ))}
                    </ol>
                </div>
            )}
        </div>
    );
};

const getStyles = (theme: GrafanaTheme2) => ({
    planBlockWrapper: css`
        margin-bottom: ${theme.spacing(1)};
        border: 1px solid ${theme.colors.border.weak};
        border-radius: 6px;
        background: ${theme.colors.background.primary};
        overflow: hidden;
    `,
    planHeader: css`
        display: flex;
        align-items: center;
        gap: ${theme.spacing(1)};
        padding: ${theme.spacing(1)};
        cursor: pointer;
        user-select: none;
        background: ${theme.colors.background.secondary};
        &:hover {
            background: ${theme.colors.action.hover};
        }
    `,
    planLabel: css`
        color: ${theme.colors.text.secondary};
        font-size: ${theme.typography.bodySmall.fontSize};
    `,
    planContent: css`
        padding: ${theme.spacing(1.5)};
        border-top: 1px solid ${theme.colors.border.weak};
        font-size: ${theme.typography.bodySmall.fontSize};
        color: ${theme.colors.text.secondary};
        background: ${theme.colors.background.primary};
    `,
    planReasoning: css`
        margin: 0 0 ${theme.spacing(1)} 0;
        color: ${theme.colors.text.secondary};
        font-style: italic;
    `,
    planStepList: css`
        margin: 0;
        padding-left: ${theme.spacing(2.5)};
        display: flex;
        flex-direction: column;
        gap: ${theme.spacing(0.75)};
    `,
    planStepItem: css`
        display: flex;
        align-items: baseline;
        gap: ${theme.spacing(1)};
        flex-wrap: wrap;
    `,
    planStepDescription: css`
        color: ${theme.colors.text.primary};
    `,
    planStepCategories: css`
        display: flex;
        gap: ${theme.spacing(0.5)};
        flex-wrap: wrap;
    `,
    planCategoryBadge: css`
        font-size: ${theme.typography.bodySmall.fontSize};
        font-family: ${theme.typography.fontFamilyMonospace};
        color: ${theme.colors.text.secondary};
        background: ${theme.colors.background.canvas};
        border: 1px solid ${theme.colors.border.weak};
        border-radius: 3px;
        padding: 0 ${theme.spacing(0.5)};
        line-height: 1.6;
    `,
});
