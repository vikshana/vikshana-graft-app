import React from 'react';
import { GrafanaTheme2 } from '@grafana/data';
import { useStyles2 } from '@grafana/ui';
import { css } from '@emotion/css';
import { Prism as SyntaxHighlighter } from 'react-syntax-highlighter';
import { vscDarkPlus, vs } from 'react-syntax-highlighter/dist/esm/styles/prism';

interface MermaidBlockProps {
    children: string;
    theme: GrafanaTheme2;
    onRender?: () => void;
    isStreaming?: boolean;
}

export const MermaidBlock: React.FC<MermaidBlockProps> = ({ children, theme, onRender, isStreaming }) => {
    const [copied, setCopied] = React.useState(false);
    const [showCode, setShowCode] = React.useState(false);
    const [isExpanded, setIsExpanded] = React.useState(false);
    const [svg, setSvg] = React.useState<string>('');
    const [error, setError] = React.useState<string>('');
    const [hasRendered, setHasRendered] = React.useState(false);
    const containerRef = React.useRef<HTMLDivElement>(null);
    const styles = useStyles2(getStyles);
    const wasStreamingRef = React.useRef(isStreaming);

    // Track when streaming completes to trigger initial render
    React.useEffect(() => {
        if (wasStreamingRef.current && !isStreaming) {
            // Streaming just completed
            setHasRendered(false); // Reset to allow rendering
        }
        wasStreamingRef.current = isStreaming;
    }, [isStreaming]);

    React.useEffect(() => {
        const renderDiagram = async () => {
            try {
                const mermaid = (await import('mermaid')).default;
                mermaid.initialize({
                    startOnLoad: false,
                    theme: theme.isDark ? 'dark' : 'default',
                    securityLevel: 'loose',
                    suppressErrorRendering: true,
                    fontFamily: 'Inter, Roboto, "Helvetica Neue", Arial, sans-serif',
                    themeVariables: {
                        fontFamily: 'Inter, Roboto, "Helvetica Neue", Arial, sans-serif',
                        darkMode: theme.isDark,
                        primaryColor: theme.colors.primary.main,
                        primaryTextColor: theme.colors.primary.contrastText,
                        secondaryColor: theme.colors.secondary.main,
                        secondaryTextColor: theme.colors.secondary.contrastText,
                        tertiaryColor: theme.colors.background.secondary,
                        tertiaryTextColor: theme.colors.text.primary,
                        textColor: theme.colors.text.primary,
                        lineColor: theme.colors.border.medium,
                        mainBkg: theme.colors.background.canvas,
                        nodeBorder: theme.colors.border.strong,
                    },
                    dompurifyConfig: {
                        USE_PROFILES: { svg: true, svgFilters: true, html: true },
                        ADD_TAGS: ['foreignObject'],
                        ADD_ATTR: ['xmlns', 'width', 'height', 'x', 'y', 'transform', 'style', 'class', 'id'],
                    },
                });

                await mermaid.parse(children);
                const id = `mermaid-${Math.random().toString(36).substring(2, 9)}`;
                const { svg: renderedSvg } = await mermaid.render(id, children);
                // Mermaid now sanitizes with DOMPurify internally using our dompurifyConfig
                setSvg(renderedSvg);
                setError('');
                setHasRendered(true);
                onRender?.();
            } catch (err) {
                setError('Failed to render diagram');
                console.error('Mermaid rendering error:', err);
            }
        };

        // Render when: showing diagram (not code), not currently streaming, and hasn't been rendered yet
        if (!showCode && !isStreaming && !hasRendered) {
            renderDiagram();
        }
    }, [theme.isDark, showCode, isStreaming, hasRendered, children, onRender, theme.colors.primary.main, theme.colors.primary.contrastText, theme.colors.secondary.main, theme.colors.secondary.contrastText, theme.colors.background.secondary, theme.colors.text.primary, theme.colors.border.medium, theme.colors.background.canvas, theme.colors.border.strong]);

    const handleCopy = async () => {
        await navigator.clipboard.writeText(children);
        setCopied(true);
        setTimeout(() => setCopied(false), 2000);
    };

    return (
        <>
            <div className={styles.codeBlockWrapper}>
                <div className={styles.codeBlockHeader}>
                    <span className={styles.languageLabel}>mermaid</span>
                    <div className={styles.mermaidControls}>
                        <button
                            className={`${styles.mermaidToggle} ${showCode ? styles.mermaidToggleActive : ''}`}
                            onClick={() => setShowCode(!showCode)}
                        >
                            {showCode ? 'Diagram' : 'Code'}
                        </button>
                        <button className={styles.copyButton} onClick={handleCopy}>
                            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                                <rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect>
                                <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path>
                            </svg>
                            <span>{copied ? 'Copied!' : 'Copy'}</span>
                        </button>
                        <button
                            className={styles.mermaidExpandButton}
                            onClick={() => setIsExpanded(true)}
                            title="Expand diagram"
                        >
                            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                                <polyline points="15 3 21 3 21 9"></polyline>
                                <polyline points="9 21 3 21 3 15"></polyline>
                                <line x1="21" y1="3" x2="14" y2="10"></line>
                                <line x1="3" y1="21" x2="10" y2="14"></line>
                            </svg>
                        </button>
                    </div>
                </div>
                <div className={styles.mermaidContent}>
                    {showCode || isStreaming ? (
                        <SyntaxHighlighter
                            style={theme.isDark ? vscDarkPlus : vs}
                            language="mermaid"
                            PreTag="div"
                            customStyle={{
                                margin: 0,
                                borderRadius: '0 0 4px 4px',
                                fontSize: '12px',
                            }}
                        >
                            {children}
                        </SyntaxHighlighter>
                    ) : error ? (
                        <div className={styles.mermaidError}>{error}</div>
                    ) : (
                        <div
                            ref={containerRef}
                            className={styles.mermaidDiagram}
                            dangerouslySetInnerHTML={{ __html: svg }}
                        />
                    )}
                </div>
            </div>

            {isExpanded && (
                <div className={styles.mermaidModal} onClick={() => setIsExpanded(false)}>
                    <div className={styles.mermaidModalContent} onClick={e => e.stopPropagation()}>
                        <div className={styles.mermaidModalHeader}>
                            <span>Mermaid Diagram</span>
                            <button className={styles.mermaidModalClose} onClick={() => setIsExpanded(false)}>
                                <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                                    <line x1="18" y1="6" x2="6" y2="18"></line>
                                    <line x1="6" y1="6" x2="18" y2="18"></line>
                                </svg>
                            </button>
                        </div>
                        <div className={styles.mermaidModalBody}>
                            {showCode ? (
                                <SyntaxHighlighter
                                    style={theme.isDark ? vscDarkPlus : vs}
                                    language="mermaid"
                                    PreTag="div"
                                    customStyle={{
                                        margin: 0,
                                        borderRadius: '4px',
                                        fontSize: '14px',
                                        width: '100%',
                                    }}
                                >
                                    {children}
                                </SyntaxHighlighter>
                            ) : (
                                <div
                                    className={styles.mermaidDiagram}
                                    dangerouslySetInnerHTML={{ __html: svg }}
                                    style={{ transform: 'scale(1.2)' }}
                                />
                            )}
                        </div>
                    </div>
                </div>
            )}
        </>
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
    mermaidControls: css`
    display: flex;
    align-items: center;
    gap: 8px;
  `,
    mermaidToggle: css`
    display: flex;
    align-items: center;
    background: ${theme.colors.background.secondary};
    border: 1px solid ${theme.colors.border.weak};
    color: ${theme.colors.text.secondary};
    cursor: pointer;
    font-size: 12px;
    padding: 4px 12px;
    border-radius: 4px;
    transition: all 0.2s;
    
    &:hover {
      background: ${theme.colors.background.canvas};
      color: ${theme.colors.text.primary};
      border-color: ${theme.colors.border.medium};
    }
  `,
    mermaidToggleActive: css`
    background: ${theme.colors.primary.main};
    color: ${theme.colors.primary.contrastText};
    border-color: ${theme.colors.primary.main};
    
    &:hover {
      background: ${theme.colors.primary.shade};
      border-color: ${theme.colors.primary.shade};
    }
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
    mermaidExpandButton: css`
    display: flex;
    align-items: center;
    background: transparent;
    border: none;
    color: ${theme.colors.text.secondary};
    cursor: pointer;
    padding: 4px;
    border-radius: 4px;
    transition: all 0.2s;
    
    &:hover {
      background: ${theme.colors.background.secondary};
      color: ${theme.colors.text.primary};
    }
  `,
    mermaidContent: css`
    padding: 16px;
    background: ${theme.colors.background.canvas};
  `,
    mermaidDiagram: css`
    display: flex;
    justify-content: center;
    align-items: center;
    
    svg {
      max-width: 100%;
      height: auto;
      
      text {
        font-family: Inter, Roboto, "Helvetica Neue", Arial, sans-serif!important;
      }
    }
  `,
    mermaidError: css`
    color: ${theme.colors.error.text};
    padding: 16px;
    text-align: center;
    font-size: 12px;
  `,
    mermaidModal: css`
    position: fixed;
    top: 0;
    left: 0;
    right: 0;
    bottom: 0;
    background: rgba(0, 0, 0, 0.8);
    display: flex;
    align-items: center;
    justify-content: center;
    z-index: 9999;
    padding: 20px;
  `,
    mermaidModalContent: css`
    background: ${theme.colors.background.primary};
    border-radius: 8px;
    max-width: 90vw;
    max-height: 90vh;
    display: flex;
    flex-direction: column;
    overflow: hidden;
    box-shadow: 0 10px 40px rgba(0, 0, 0, 0.3);
  `,
    mermaidModalHeader: css`
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 16px 20px;
    border-bottom: 1px solid ${theme.colors.border.weak};
    background: ${theme.colors.background.secondary};
    
    span {
      font-weight: 600;
      font-size: 16px;
    }
  `,
    mermaidModalClose: css`
    background: transparent;
    border: none;
    color: ${theme.colors.text.secondary};
    cursor: pointer;
    padding: 4px;
    border-radius: 4px;
    transition: all 0.2s;
    display: flex;
    align-items: center;
    
    &:hover {
      background: ${theme.colors.background.primary};
      color: ${theme.colors.text.primary};
    }
  `,
    mermaidModalBody: css`
    padding: 32px;
    overflow: auto;
    flex: 1;
    display: flex;
    align-items: center;
    justify-content: center;
    
    svg {
      max-width: 100%;
      height: auto;
    }
  `,
});
