import React, { useState, useRef, useEffect } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { GrafanaTheme2 } from '@grafana/data';
import { useStyles2, Icon } from '@grafana/ui';
import { css } from '@emotion/css';

// Helper function to normalize markdown content
const normalizeMarkdown = (content: string): string => {
    // Replace multiple consecutive newlines with a single newline
    return content.replace(/\n\n+/g, '\n');
};

interface ThinkingBlockProps {
    content: string;
    isStreaming: boolean;
    thinkingSeconds?: number;
    startTime?: number | null;
}

export const ThinkingBlock: React.FC<ThinkingBlockProps> = ({ content, isStreaming, thinkingSeconds, startTime }) => {
    const [isExpanded, setIsExpanded] = useState(false);
    const [elapsedSeconds, setElapsedSeconds] = useState(0);
    // Initialize finalSeconds from prop if available (for persisted messages)
    const [finalSeconds, setFinalSeconds] = useState<number | null>(thinkingSeconds ?? null);
    const internalStartTimeRef = useRef<number | null>(null);
    const intervalRef = useRef<NodeJS.Timeout | null>(null);
    const styles = useStyles2(getStyles);

    useEffect(() => {
        if (isStreaming) {
            // Use provided startTime or fallback to internal ref
            const effectiveStartTime = startTime || internalStartTimeRef.current || Date.now();

            if (!startTime && internalStartTimeRef.current === null) {
                internalStartTimeRef.current = effectiveStartTime;
            }

            // Clear any existing interval
            if (intervalRef.current) {
                clearInterval(intervalRef.current);
            }

            // Start interval for elapsed time updates
            intervalRef.current = setInterval(() => {
                setElapsedSeconds(Math.floor((Date.now() - effectiveStartTime) / 1000));
            }, 1000);
        } else {
            // Streaming stopped - save final time and reset
            // Using functional setState to capture final time only once
            setFinalSeconds((prev) => {
                if (prev !== null) {
                    return prev;
                }
                const effectiveStartTime = startTime || internalStartTimeRef.current;
                if (effectiveStartTime) {
                    return Math.floor((Date.now() - effectiveStartTime) / 1000);
                }
                return 0;
            });
            internalStartTimeRef.current = null;
            if (intervalRef.current) {
                clearInterval(intervalRef.current);
                intervalRef.current = null;
            }
        }

        // Always return cleanup function
        return () => {
            if (intervalRef.current) {
                clearInterval(intervalRef.current);
            }
        };
    }, [isStreaming, startTime]);

    const displayTime = isStreaming ? elapsedSeconds : (finalSeconds || 0);

    return (
        <div className={styles.thinkingBlockWrapper}>
            <div
                className={styles.thinkingHeader}
                onClick={() => setIsExpanded(!isExpanded)}
            >
                <Icon name={isExpanded ? 'angle-down' : 'angle-right'} />
                <span className={styles.thinkingLabel}>
                    {isStreaming ? `Thinking for ${displayTime}s` : `Thought for ${displayTime}s`}
                </span>
            </div>
            {isExpanded && (
                <div className={styles.thinkingContent}>
                    <ReactMarkdown remarkPlugins={[remarkGfm]}>
                        {normalizeMarkdown(content)}
                    </ReactMarkdown>
                </div>
            )}
        </div>
    );
};

const getStyles = (theme: GrafanaTheme2) => ({
    thinkingBlockWrapper: css`
    margin-bottom: ${theme.spacing(1)};
    border: 1px solid ${theme.colors.border.weak};
    border-radius: 6px;
    background: ${theme.colors.background.primary};
    overflow: hidden;
  `,
    thinkingHeader: css`
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
    thinkingLabel: css`
    color: ${theme.colors.text.secondary};
    font-size: ${theme.typography.bodySmall.fontSize};
  `,
    thinkingContent: css`
    padding: ${theme.spacing(1.5)};
    border-top: 1px solid ${theme.colors.border.weak};
    font-size: ${theme.typography.bodySmall.fontSize};
    color: ${theme.colors.text.secondary};
    background: ${theme.colors.background.primary};
  `,
});
