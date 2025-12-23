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

export const CodeBlock: React.FC<CodeBlockProps> = ({ language, children, theme }) => {
    const [copied, setCopied] = React.useState(false);
    const styles = useStyles2(getStyles);

    const handleCopy = async () => {
        await navigator.clipboard.writeText(children);
        setCopied(true);
        setTimeout(() => setCopied(false), 2000);
    };

    return (
        <div className={styles.codeBlockWrapper}>
            <div className={styles.codeBlockHeader}>
                <span className={styles.languageLabel}>{language}</span>
                <button className={styles.copyButton} onClick={handleCopy}>
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                        <rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect>
                        <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path>
                    </svg>
                    <span>{copied ? 'Copied!' : 'Copy'}</span>
                </button>
            </div>
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
                {children}
            </SyntaxHighlighter>
        </div>
    );
};

const getStyles = (theme: GrafanaTheme2) => ({
    codeBlockWrapper: css`
    margin: 8px 0;
    border-radius: 4px;
    overflow: hidden;
    background: ${theme.colors.background.primary};
  `,
    codeBlockHeader: css`
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 8px 12px;
    background: ${theme.colors.background.primary};
    border-bottom: 1px solid ${theme.colors.border.weak};
  `,
    languageLabel: css`
    font-size: 12px;
    color: ${theme.colors.text.secondary};
    font-family: ${theme.typography.fontFamilyMonospace};
    text-transform: lowercase;
  `,
    copyButton: css`
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
});
