import React from 'react';
import { GrafanaTheme2 } from '@grafana/data';
import { Alert, Button, useStyles2 } from '@grafana/ui';
import { css } from '@emotion/css';

interface ErrorBoundaryProps {
    children: React.ReactNode;
    fallback?: React.ReactNode;
}

interface ErrorBoundaryState {
    hasError: boolean;
    error: Error | null;
    errorInfo: React.ErrorInfo | null;
}

export class ErrorBoundary extends React.Component<ErrorBoundaryProps, ErrorBoundaryState> {
    constructor(props: ErrorBoundaryProps) {
        super(props);
        this.state = {
            hasError: false,
            error: null,
            errorInfo: null,
        };
    }

    static getDerivedStateFromError(error: Error): Partial<ErrorBoundaryState> {
        return { hasError: true, error };
    }

    componentDidCatch(error: Error, errorInfo: React.ErrorInfo) {
        console.error('ErrorBoundary caught an error:', error, errorInfo);
        this.setState({ errorInfo });
    }

    handleReset = () => {
        this.setState({
            hasError: false,
            error: null,
            errorInfo: null,
        });
    };

    render() {
        if (this.state.hasError) {
            if (this.props.fallback) {
                return this.props.fallback;
            }

            return <DefaultErrorUI error={this.state.error} errorInfo={this.state.errorInfo} onReset={this.handleReset} />;
        }

        return this.props.children;
    }
}

interface DefaultErrorUIProps {
    error: Error | null;
    errorInfo: React.ErrorInfo | null;
    onReset: () => void;
}

const DefaultErrorUI: React.FC<DefaultErrorUIProps> = ({ error, errorInfo, onReset }) => {
    const styles = useStyles2(getStyles);

    return (
        <div className={styles.container}>
            <div className={styles.content}>
                <Alert severity="error" title="Something went wrong">
                    <div className={styles.errorMessage}>
                        {error?.message || 'An unexpected error occurred'}
                    </div>

                    <div className={styles.actions}>
                        <Button onClick={onReset} variant="primary">
                            Try Again
                        </Button>
                        <Button onClick={() => window.location.href = '/'} variant="secondary">
                            Go to Home
                        </Button>
                    </div>

                    {process.env.NODE_ENV === 'development' && errorInfo && (
                        <details className={styles.errorDetails}>
                            <summary>Error Details (Development Only)</summary>
                            <pre className={styles.stackTrace}>
                                {error?.stack}
                                {'\n\nComponent Stack:\n'}
                                {errorInfo.componentStack}
                            </pre>
                        </details>
                    )}
                </Alert>
            </div>
        </div>
    );
};

const getStyles = (theme: GrafanaTheme2) => ({
    container: css`
    display: flex;
    align-items: center;
    justify-content: center;
    min-height: 100vh;
    padding: ${theme.spacing(2)};
    background: ${theme.colors.background.canvas};
  `,
    content: css`
    max-width: 600px;
    width: 100%;
  `,
    errorMessage: css`
    margin-bottom: ${theme.spacing(2)};
    font-size: ${theme.typography.body.fontSize};
    color: ${theme.colors.text.primary};
  `,
    actions: css`
    display: flex;
    gap: ${theme.spacing(1)};
    margin-top: ${theme.spacing(2)};
  `,
    errorDetails: css`
    margin-top: ${theme.spacing(2)};
    cursor: pointer;
    
    summary {
      font-weight: ${theme.typography.fontWeightMedium};
      padding: ${theme.spacing(1)};
      background: ${theme.colors.background.secondary};
      border-radius: ${theme.shape.borderRadius()};
      
      &:hover {
        background: ${theme.colors.background.primary};
      }
    }
  `,
    stackTrace: css`
    margin-top: ${theme.spacing(1)};
    padding: ${theme.spacing(2)};
    background: ${theme.colors.background.primary};
    border: 1px solid ${theme.colors.border.weak};
    border-radius: ${theme.shape.borderRadius()};
    font-family: ${theme.typography.fontFamilyMonospace};
    font-size: 12px;
    overflow-x: auto;
    white-space: pre-wrap;
    word-break: break-word;
  `,
});
