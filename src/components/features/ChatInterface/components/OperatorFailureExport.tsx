import React, { useCallback, useMemo, useState } from 'react';
import { GrafanaTheme2 } from '@grafana/data';
import { Button, Modal, TextArea, useStyles2 } from '@grafana/ui';
import { css } from '@emotion/css';
import {
    clearGraftFailures,
    downloadTextFile,
    exportGraftOperatorReportAsJson,
    exportGraftOperatorReportAsMarkdown,
} from '../../../../services/graftOperatorFailureLog';
import { useGraftFailureCount } from '../hooks/useGraftFailureCount';

export const OperatorFailureExport: React.FC = () => {
    const styles = useStyles2(getStyles);
    const [open, setOpen] = useState(false);
    const [copied, setCopied] = useState(false);
    const failureCount = useGraftFailureCount();

    const reportMarkdown = useMemo(
        () => (open ? exportGraftOperatorReportAsMarkdown() : ''),
        [open, failureCount]
    );

    const handleCopy = useCallback(async () => {
        await navigator.clipboard.writeText(exportGraftOperatorReportAsMarkdown());
        setCopied(true);
        setTimeout(() => setCopied(false), 2000);
    }, []);

    const handleDownloadMarkdown = useCallback(() => {
        const stamp = new Date().toISOString().slice(0, 10);
        downloadTextFile(
            `graft-failure-report-${stamp}.md`,
            exportGraftOperatorReportAsMarkdown(),
            'text/markdown;charset=utf-8'
        );
    }, []);

    const handleDownloadJson = useCallback(() => {
        const stamp = new Date().toISOString().slice(0, 10);
        downloadTextFile(
            `graft-failure-report-${stamp}.json`,
            exportGraftOperatorReportAsJson(),
            'application/json;charset=utf-8'
        );
    }, []);

    const handleClear = useCallback(() => {
        clearGraftFailures();
        setOpen(false);
    }, []);

    return (
        <>
            <Button
                variant={failureCount > 0 ? 'primary' : 'secondary'}
                fill="outline"
                size="sm"
                icon="download-alt"
                onClick={() => setOpen(true)}
                data-testid="export-failures-button"
                title="Export operator failures and suggested programmatic registry rows for Cursor"
            >
                Export failures{failureCount > 0 ? ` (${failureCount})` : ''}
            </Button>

            {open && (
                <Modal
                    title="Graft failure export"
                    isOpen={open}
                    onDismiss={() => setOpen(false)}
                    closeOnBackdropClick
                >
                    <p className={styles.help}>
                        Paste this into Cursor when adding a programmatic handler. Includes logged failures
                        from this browser plus suggested <code>PROGRAMMATIC_FALLBACK_REGISTRY</code> stubs
                        (files to edit, trigger text, handler name).
                    </p>
                    <TextArea
                        className={styles.preview}
                        value={reportMarkdown}
                        readOnly
                        rows={18}
                    />
                    <div className={styles.actions}>
                        <Button variant="secondary" onClick={handleCopy} icon="copy">
                            {copied ? 'Copied' : 'Copy markdown'}
                        </Button>
                        <Button variant="secondary" onClick={handleDownloadMarkdown} icon="download-alt">
                            Download .md
                        </Button>
                        <Button variant="secondary" onClick={handleDownloadJson} icon="download-alt">
                            Download .json
                        </Button>
                        <Button variant="destructive" fill="outline" onClick={handleClear} icon="trash-alt">
                            Clear log
                        </Button>
                    </div>
                </Modal>
            )}
        </>
    );
};

const getStyles = (theme: GrafanaTheme2) => ({
    help: css`
        margin: 0 0 ${theme.spacing(2)} 0;
        color: ${theme.colors.text.secondary};
        font-size: ${theme.typography.bodySmall.fontSize};
        code {
            font-family: ${theme.typography.fontFamilyMonospace};
        }
    `,
    preview: css`
        font-family: ${theme.typography.fontFamilyMonospace};
        font-size: 12px;
        width: 100%;
    `,
    actions: css`
        display: flex;
        flex-wrap: wrap;
        gap: ${theme.spacing(1)};
        margin-top: ${theme.spacing(2)};
    `,
});
