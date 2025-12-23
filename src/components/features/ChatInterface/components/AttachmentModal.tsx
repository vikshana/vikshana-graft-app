import React from 'react';
import { GrafanaTheme2 } from '@grafana/data';
import { useStyles2, useTheme2, Icon } from '@grafana/ui';
import { css } from '@emotion/css';

interface AttachmentModalProps {
    isOpen: boolean;
    onClose: () => void;
    attachment: { name: string; content: string; type: 'image' | 'text'; mimeType?: string } | null;
}

export const AttachmentModal: React.FC<AttachmentModalProps> = ({ isOpen, onClose, attachment }) => {
    const styles = useStyles2(getStyles);
    const theme = useTheme2();

    if (!isOpen || !attachment) {return null;}

    return (
        <div className={styles.modal} onClick={onClose}>
            <div className={styles.modalContent} onClick={(e) => e.stopPropagation()}>
                <div className={styles.modalHeader}>
                    <span>{attachment.name}</span>
                    <button className={styles.modalClose} onClick={onClose}>
                        <Icon name="times" size="lg" />
                    </button>
                </div>
                <div className={styles.modalBody}>
                    {attachment.type === 'image' ? (
                        <img
                            src={attachment.content.startsWith('data:') ? attachment.content : `data:${attachment.mimeType || 'image/jpeg'};base64,${attachment.content}`}
                            alt={attachment.name}
                            style={{ maxWidth: '100%', maxHeight: '100%', objectFit: 'contain' }}
                        />
                    ) : (
                        <pre style={{
                            margin: 0,
                            padding: '16px',
                            background: theme.colors.background.canvas,
                            borderRadius: '4px',
                            width: '100%',
                            overflow: 'auto',
                            fontFamily: theme.typography.fontFamilyMonospace,
                            fontSize: '12px'
                        }}>
                            {attachment.content}
                        </pre>
                    )}
                </div>
            </div>
        </div>
    );
};

const getStyles = (theme: GrafanaTheme2) => ({
    modal: css`
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
    modalContent: css`
    background: ${theme.colors.background.primary};
    border-radius: 8px;
    max-width: 90vw;
    max-height: 90vh;
    display: flex;
    flex-direction: column;
    overflow: hidden;
    box-shadow: 0 10px 40px rgba(0, 0, 0, 0.3);
  `,
    modalHeader: css`
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
    modalClose: css`
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
    modalBody: css`
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
