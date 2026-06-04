import React from 'react';
import { GrafanaTheme2 } from '@grafana/data';
import { css } from '@emotion/css';

interface ContinueActionBannerProps {
    theme: GrafanaTheme2;
    onContinue: () => void;
    disabled?: boolean;
    autoContinuing?: boolean;
}

export function ContinueActionBanner({
    theme,
    onContinue,
    disabled = false,
    autoContinuing = false,
}: ContinueActionBannerProps) {
    const styles = getStyles(theme);
    return (
        <div className={styles.banner} role="region" aria-label="Continue required">
            <div className={styles.title}>Action required</div>
            <p className={styles.body}>
                {autoContinuing
                    ? 'Graft is continuing automatically to finish saving…'
                    : 'Graft stopped before the dashboard save finished. Tap Continue — you do not need panel numbers or UIDs.'}
            </p>
            <button
                type="button"
                className={styles.button}
                onClick={onContinue}
                disabled={disabled || autoContinuing}
                data-testid="graft-continue-button"
            >
                {autoContinuing ? 'Continuing…' : 'Continue'}
            </button>
        </div>
    );
}

function getStyles(theme: GrafanaTheme2) {
    return {
        banner: css`
            margin-top: ${theme.spacing(2)};
            padding: ${theme.spacing(2)};
            border-radius: ${theme.shape.radius.default};
            border: 2px solid ${theme.colors.warning.border};
            background: ${theme.isDark ? 'rgba(255, 153, 0, 0.12)' : 'rgba(255, 153, 0, 0.15)'};
            box-shadow: 0 0 0 1px ${theme.colors.warning.border};
        `,
        title: css`
            font-size: ${theme.typography.h5.fontSize};
            font-weight: 700;
            color: ${theme.colors.warning.text};
            margin: 0 0 ${theme.spacing(1)} 0;
        `,
        body: css`
            margin: 0 0 ${theme.spacing(1.5)} 0;
            font-size: ${theme.typography.body.fontSize};
            line-height: 1.45;
            color: ${theme.colors.text.primary};
        `,
        button: css`
            display: inline-flex;
            align-items: center;
            justify-content: center;
            padding: ${theme.spacing(1, 2)};
            border: none;
            border-radius: ${theme.shape.radius.default};
            background: ${theme.colors.warning.main};
            color: ${theme.colors.warning.contrastText};
            font-weight: 700;
            font-size: ${theme.typography.body.fontSize};
            cursor: pointer;

            &:disabled {
                opacity: 0.65;
                cursor: not-allowed;
            }

            &:hover:not(:disabled) {
                filter: brightness(1.05);
            }
        `,
    };
}
