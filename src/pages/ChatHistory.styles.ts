import { GrafanaTheme2 } from '@grafana/data';
import { css } from '@emotion/css';

export
const getStyles = (theme: GrafanaTheme2) => ({
  container: css`
    display: flex;
    flex-direction: column;
    height: 100%;
    background: ${theme.colors.background.primary};
  `,
  header: css`
    display: flex;
    justify-content: space-between;
    align-items: center;
    padding: ${theme.spacing(2)};
    border-bottom: 1px solid ${theme.colors.border.weak};
    background: ${theme.colors.background.primary};
    position: sticky;
    top: 40px;
    z-index: 10;
  `,
  title: css`
    font-size: ${theme.typography.h4.fontSize};
    font-weight: ${theme.typography.fontWeightMedium};
    color: ${theme.colors.text.primary};
    margin: 0;
    position: absolute;
    left: 50%;
    transform: translateX(-50%);
    white-space: nowrap;
  `,
  searchWrapper: css`
    width: 300px;
    display: flex;
    justify-content: flex-end;
  `,
  content: css`
    flex: 1;
    overflow-y: auto;
    padding: ${theme.spacing(3)};
  `,
  sessionGrid: css`
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(300px, 1fr));
    gap: ${theme.spacing(2)};
    padding: ${theme.spacing(1)};
  `,
  sessionCard: css`
    position: relative;
    padding: ${theme.spacing(2)};
    padding-bottom: ${theme.spacing(4)};
    background: ${theme.colors.background.secondary};
    border-radius: 8px;
    border: 1px solid ${theme.colors.border.weak};
    cursor: pointer;
    transition: all 0.2s;
    &:hover {
      border-color: #faab44;
      transform: translateY(-2px);
      box-shadow: 0 4px 12px rgba(0, 0, 0, 0.1);
    }
    &:hover button {
      opacity: 1;
    }
  `,
  cardHeader: css`
    display: flex;
    justify-content: space-between;
    align-items: center;
    margin-bottom: ${theme.spacing(1)};
  `,
  chatIcon: css`
    font-size: 20px;
  `,
  cardDate: css`
    font-size: 12px;
    color: ${theme.colors.text.secondary};
    position: absolute;
    bottom: ${theme.spacing(1)};
    right: ${theme.spacing(1)};
  `,
  cardTitle: css`
    font-size: 16px;
    font-weight: 600;
    margin-bottom: ${theme.spacing(0.5)};
    color: ${theme.colors.text.primary};
    overflow: hidden;
    text-overflow: ellipsis;
    display: -webkit-box;
    -webkit-line-clamp: 2;
    -webkit-box-orient: vertical;
  `,
  cardPreview: css`
    font-size: 14px;
    color: ${theme.colors.text.secondary};
    overflow: hidden;
    text-overflow: ellipsis;
    display: -webkit-box;
    -webkit-line-clamp: 2;
    -webkit-box-orient: vertical;
    line-height: 1.4;
  `,
  pinBtn: css`
    position: absolute;
    top: ${theme.spacing(1)};
    right: ${theme.spacing(5)};
    background: transparent;
    border: 1px solid #ed6f3e;
    border-radius: 4px;
    cursor: pointer;
    padding: ${theme.spacing(0.5)};
    color: #ed6f3e;
    display: flex;
    align-items: center;
    justify-content: center;
    width: 28px;
    height: 28px;
    opacity: 0;
    transition: opacity 0.2s;
    &:hover {
      color: #ed6f3e;
    }
    svg {
      width: 14px;
      height: 14px;
    }
  `,
  pinned: css`
    opacity: 1;
    color: #ed6f3e;
    border-color: #ed6f3e;
    &:hover {
      border: 1px solid #ed6f3e;
      color: #ed6f3e;
      background: ${theme.colors.error.transparent};
    }
  `,
  deleteBtn: css`
    position: absolute;
    top: ${theme.spacing(1)};
    right: ${theme.spacing(1)};
    background: ${theme.colors.background.primary};
    border: 1px solid ${theme.colors.border.weak};
    border-radius: 4px;
    cursor: pointer;
    padding: ${theme.spacing(0.5)};
    color: ${theme.colors.text.secondary};
    display: flex;
    align-items: center;
    justify-content: center;
    width: 28px;
    height: 28px;
    opacity: 1;
    transition: opacity 0.2s;
    &:hover {
      color: #ed6f3e;
      background: ${theme.colors.error.transparent};
    }
    svg {
      width: 14px;
      height: 14px;
    }
  `,
  emptyState: css`
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    padding: ${theme.spacing(8)};
    text-align: center;
  `,
  emptyIcon: css`
    font-size: 64px;
    margin-bottom: ${theme.spacing(2)};
    opacity: 0.5;
  `,
  emptyTitle: css`
    font-size: 20px;
    font-weight: 600;
    margin-bottom: ${theme.spacing(1)};
    color: ${theme.colors.text.primary};
  `,
  emptyDesc: css`
    font-size: 14px;
    color: ${theme.colors.text.secondary};
  `,
  headerLeft: css`
    display: flex;
    align-items: center;
  `,
  headerActions: css`
    display: flex;
    align-items: center;
    gap: ${theme.spacing(2)};
  `,
  selectionToolbar: css`
    display: flex;
    align-items: center;
    gap: ${theme.spacing(2)};
    flex: 1;
    justify-content: space-between;
    margin-left: ${theme.spacing(2)};
  `,
  selectionCount: css`
    font-size: 14px;
    font-weight: 500;
    color: ${theme.colors.text.primary};
  `,
  selectionActions: css`
    display: flex;
    align-items: center;
    gap: ${theme.spacing(1)};
  `,
  sessionCheckbox: css`
    position: absolute;
    top: ${theme.spacing(1)};
    right: ${theme.spacing(1)};
    z-index: 2;
    input[type="checkbox"] {
      width: 18px;
      height: 18px;
      cursor: pointer;
    }
  `,
  sessionSelectable: css`
    cursor: pointer;
    &:hover {
      background: ${theme.colors.background.secondary};
    }
  `,
  sessionSelected: css`
    background: ${theme.colors.background.secondary};
    border-color: ${theme.colors.primary.main};
    box-shadow: 0 0 0 1px ${theme.colors.primary.main};
  `,
  sectionHeader: css`
    display: flex;
    align-items: center;
    gap: ${theme.spacing(1)};
    padding: ${theme.spacing(2)} ${theme.spacing(1)};
    font-size: 14px;
    font-weight: 600;
    color: ${theme.colors.text.secondary};
    text-transform: uppercase;
    letter-spacing: 0.5px;
  `,
  divider: css`
    height: 1px;
    background: ${theme.colors.border.weak};
    margin: ${theme.spacing(3)} 0;
  `,
});

