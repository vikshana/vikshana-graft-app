import React from 'react';
import { GrafanaTheme2 } from '@grafana/data';
import { useStyles2, Icon } from '@grafana/ui';
import { css } from '@emotion/css';

interface FilePreviewProps {
    file: { name: string; content: string; type: 'image' | 'text'; mimeType?: string };
    onRemove?: () => void;
    onExpand: () => void;
}

export const FilePreview: React.FC<FilePreviewProps> = ({ file, onRemove, onExpand }) => {
    const styles = useStyles2(getStyles);

    return (
        <div className={styles.filePreviewItem}>
            {file.type === 'image' ? (
                <div className={styles.previewContainer} style={{ position: 'relative' }}>
                    <img
                        src={file.content.startsWith('data:') ? file.content : `data:${file.mimeType || 'image/jpeg'};base64,${file.content}`}
                        alt="Preview"
                        className={styles.previewImage}
                        style={{ width: '120px', height: '80px', objectFit: 'cover', borderRadius: '4px' }}
                    />
                    <div className={styles.expandIconOverlay} onClick={onExpand}>
                        <Icon name="search-plus" size="lg" />
                    </div>
                    <span className={styles.fileName} title={file.name}>
                        {file.name}
                    </span>
                </div>
            ) : (
                <div className={styles.previewContainer}>
                    <div className={styles.textPreviewContent}>
                        {file.content.slice(0, 300)}
                        {file.content.length > 300 && '...'}
                    </div>
                    <div className={styles.fileName} title={file.name}>
                        <Icon name="file-alt" />
                        <span>{file.name}</span>
                    </div>
                    <div
                        className={styles.expandIconOverlay}
                        onClick={onExpand}
                        style={{ position: 'absolute', top: 0, left: 0, width: '100%', height: '100%' }}
                    >
                        <Icon name="search-plus" size="lg" />
                    </div>
                </div>
            )}
            {onRemove && (
                <button className={styles.removeFileButton} onClick={onRemove} data-testid="remove-file-button">
                    <Icon name="times" />
                </button>
            )}
        </div>
    );
};

const getStyles = (theme: GrafanaTheme2) => ({
    filePreviewItem: css`
    position: relative;
    flex-shrink: 0;
    background: ${theme.colors.background.primary};
    border-radius: 4px;
    padding: 4px;
    border: 1px solid ${theme.colors.border.weak};
  `,
    previewContainer: css`
    display: flex;
    flex-direction: column;
    gap: 4px;
    width: 120px;
  `,
    previewImage: css`
    max-height: 60px;
    border-radius: 4px;
    display: block;
  `,
    expandIconOverlay: css`
    position: absolute;
    top: 0;
    left: 0;
    width: 100%;
    height: 100%;
    background: rgba(0, 0, 0, 0.5);
    display: flex;
    align-items: center;
    justify-content: center;
    opacity: 0;
    transition: opacity 0.2s ease;
    cursor: pointer;
    color: white;
    
    &:hover {
      opacity: 1;
    }
  `,
    fileName: css`
    display: flex;
    align-items: center;
    gap: 4px;
    font-size: 10px;
    color: ${theme.colors.text.primary};
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  `,
    textPreviewContent: css`
    font-family: ${theme.typography.fontFamilyMonospace};
    font-size: 9px;
    background: ${theme.colors.background.canvas};
    padding: 4px;
    border-radius: 4px;
    height: 60px;
    overflow: hidden;
    white-space: pre-wrap;
    border: 1px solid ${theme.colors.border.weak};
    color: ${theme.colors.text.secondary};
  `,
    removeFileButton: css`
    position: absolute;
    top: -6px;
    right: -6px;
    background: ${theme.colors.background.primary};
    border: 1px solid ${theme.colors.border.weak};
    border-radius: 50%;
    cursor: pointer;
    color: ${theme.colors.text.secondary};
    display: flex;
    align-items: center;
    justify-content: center;
    width: 20px;
    height: 20px;
    padding: 0;
    box-shadow: 0 2px 4px rgba(0, 0, 0, 0.1);
    
    &:hover {
      color: ${theme.colors.error.text};
      border-color: ${theme.colors.error.border};
    }
    
    svg {
      width: 12px;
      height: 12px;
    }
  `,
});
