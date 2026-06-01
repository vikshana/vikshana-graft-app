import React from 'react';
import { GrafanaTheme2 } from '@grafana/data';
import { useStyles2 } from '@grafana/ui';
import { css } from '@emotion/css';
import { Prism as SyntaxHighlighter } from 'react-syntax-highlighter';
import { vscDarkPlus, vs } from 'react-syntax-highlighter/dist/esm/styles/prism';

interface CodeBlockProps {
    language: string;
    children: string;
    theme: GrafanaTheme2;
}

const COLLAPSED_MAX_HEIGHT = 420;
const LARGE_BLOCK_LINE_THRESHOLD = 20;

function toCodeText(children: React.ReactNode): string {
    if (Array.isArray(children)) {
        return children.join('');
    }
    return String(children).replace(/\n$/, '');
}

function fileExtension(language: string): string {
    switch (language) {
        case 'json':
            return 'json';
        case 'yaml':
        case 'yml':
            return 'yml';
        case 'promql':
            return 'promql';
        default:
            return 'txt';
    }
}

export const CodeBlock: React.FC<CodeBlockProps> = ({ language, children, theme }) => {
    const [copied, setCopied] = React.useState(false);
    const [expanded, setExpanded] = React.useState(false);
    const styles = useStyles2(getStyles);
    const codeText = toCodeText(children);
    const lineCount = codeText.split('\n').length;
    const isLarge = lineCount > LARGE_BLOCK_LINE_THRESHOLD || codeText.length > 2000;
    const showExpand = isLarge && !expanded;

    const handleCopy = async () => {
        await navigator.clipboard.writeText(codeText);
        setCopied(true);
        setTimeout(() => setCopied(false), 2000);
    };

    const handleDownload = () => {
        const blob = new Blob([codeText], { type: 'text/plain;charset=utf-8' });
        const url = URL.createObjectURL(blob);
        const anchor = document.createElement('a');
        anchor.href = url;
        anchor.download = `graft-${language}-${Date.now()}.${fileExtension(language)}`;
        anchor.click();
        URL.revokeObjectURL(url);
    };

    return (
        <div className={styles.codeBlockWrapper}>
            <div className={styles.codeBlockHeader}>
                <span className={styles.languageLabel}>{language}</span>
                <div className={styles.headerActions}>
                    {isLarge && (
                        <button
                            type="button"
                            className={styles.actionButton}
                            onClick={() => setExpanded((prev) => !prev)}
                        >
                            {expanded ? 'Collapse' : 'Expand'}
                        </button>
                    )}
                    {isLarge && (
                        <button type="button" className={styles.actionButton} onClick={handleDownload}>
                            Download
                        </button>
                    )}
                    <button type="button" className={styles.actionButton} onClick={handleCopy}>
                        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                            <rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect>
                            <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path>
                        </svg>
                        <span>{copied ? 'Copied!' : 'Copy'}</span>
                    </button>
                </div>
            </div>
            <div
                className={styles.codeBlockBody}
                style={showExpand ? { maxHeight: COLLAPSED_MAX_HEIGHT } : undefined}
            >
                <SyntaxHighlighter
                    style={theme.isDark ? vscDarkPlus : vs}
                    language={language}
                    PreTag="div"
                    customStyle={{
                        margin: 0,
                        borderRadius: '0 0 4px 4px',
                        fontSize: '12px',
                    }}
                >
                    {codeText}
                </SyntaxHighlighter>
            </div>
            {showExpand && <div className={styles.fadeHint}>Large block — use Expand or Copy for the full content</div>}
        </div>
    );
};

const getStyles = (theme: GrafanaTheme2) => ({
    codeBlockWrapper: css`
    margin: 8px 0;
    border-radius: 4px;
    overflow: hidden;
    background: ${theme.colors.background.primary};
    border: 1px solid ${theme.colors.border.weak};
  `,
    codeBlockHeader: css`
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 8px 12px;
    background: ${theme.colors.background.primary};
    border-bottom: 1px solid ${theme.colors.border.weak};
  `,
    headerActions: css`
    display: flex;
    align-items: center;
    gap: 4px;
  `,
    languageLabel: css`
    font-size: 12px;
    color: ${theme.colors.text.secondary};
    font-family: ${theme.typography.fontFamilyMonospace};
    text-transform: lowercase;
  `,
    actionButton: css`
    display: flex;
    align-items: center;
    gap: 4px;
    background: transparent;
    border: none;
    color: ${theme.colors.text.secondary};
    cursor: pointer;
    font-size: 12px;
    padding: 4px 8px;
    border-radius: 4px;
    transition: all 0.2s;

    &:hover {
      background: ${theme.colors.background.secondary};
      color: ${theme.colors.text.primary};
    }

    svg {
      width: 14px;
      height: 14px;
    }
  `,
    codeBlockBody: css`
    overflow: auto;
  `,
    fadeHint: css`
    padding: 6px 12px 10px;
    font-size: 11px;
    color: ${theme.colors.text.secondary};
    background: ${theme.colors.background.secondary};
    border-top: 1px solid ${theme.colors.border.weak};
  `,
});
