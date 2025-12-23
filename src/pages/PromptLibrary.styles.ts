import { GrafanaTheme2 } from '@grafana/data';
import { css } from '@emotion/css';

export const getStyles = (theme: GrafanaTheme2) => ({
  container: css`
    display: flex;
    flex-direction: column;
    height: 100%;
    background: ${theme.colors.background.primary};
    font-family: ${theme.typography.fontFamily};
  `,
  stickySection: css`
    position: sticky;
    top: 40px;
    z-index: 10;
    background: ${theme.colors.background.primary};
  `,
  header: css`
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: ${theme.spacing(2)};
    border-bottom: 1px solid ${theme.colors.border.weak};
    background: ${theme.colors.background.primary};
  `,
  headerLeft: css`
    flex: 1;
  `,
  headerRight: css`
    flex: 1;
    display: flex;
    justify-content: flex-end;
  `,
  title: css`
    font-size: ${theme.typography.h3.fontSize};
    font-weight: ${theme.typography.fontWeightMedium};
    color: ${theme.colors.text.primary};
  `,
  content: css`
    flex: 1;
    overflow-y: auto;
    padding: ${theme.spacing(3)};
    max-width: 1200px;
    width: 100%;
    margin: 0 auto;
  `,
  tabs: css`
    padding: 0 ${theme.spacing(2)};
    background: ${theme.colors.background.primary};
    display: flex;
    justify-content: center;
  `,
  promptGrid: css`
    display: flex;
    flex-direction: column;
    gap: ${theme.spacing(4)};
  `,
  categorySection: css`
    display: flex;
    flex-direction: column;
    gap: ${theme.spacing(2)};
  `,
  categoryTitle: css`
    font-size: ${theme.typography.h4.fontSize};
    color: ${theme.colors.text.primary};
    border-bottom: 2px solid #ed6f3e;
    padding-bottom: ${theme.spacing(1)};
    display: inline-block;
  `,
  subCategoryGrid: css`
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(350px, 1fr));
    gap: ${theme.spacing(3)};
  `,
  subCategoryCard: css`
    background: ${theme.colors.background.secondary};
    border: 1px solid ${theme.colors.border.weak};
    border-radius: 8px;
    padding: ${theme.spacing(2)};
  `,
  subCategoryTitle: css`
    font-size: ${theme.typography.h5.fontSize};
    margin-bottom: ${theme.spacing(2)};
    color: ${theme.colors.text.secondary};
    text-transform: capitalize;
  `,
  promptList: css`
    display: flex;
    flex-direction: column;
    gap: ${theme.spacing(1)};
  `,
  promptItem: css`
    position: relative;
    padding: ${theme.spacing(1.5)};
    padding-right: ${theme.spacing(4)};
    background: ${theme.colors.background.primary};
    border-radius: 4px;
    cursor: pointer;
    display: flex;
    align-items: center;
    justify-content: space-between;
    transition: all 0.2s;
    border: 1px solid transparent;

    &:hover {
      border-color: ${theme.colors.primary.border};
      transform: translateX(4px);
      
      .arrowIcon {
        opacity: 1;
        transform: translateX(0);
      }
    }
  `,
  pinButton: css`
    position: absolute;
    top: 2px;
    right: 2px;
    background: transparent;
    border: none;
    color: ${theme.colors.text.secondary};
    cursor: pointer;
    padding: 4px;
    border-radius: 4px;
    opacity: 0.7;
    z-index: 2;
    
    &:hover {
      background: ${theme.colors.background.secondary};
      color: ${theme.colors.text.primary};
      opacity: 1;
    }

    &.active {
      color: ${theme.colors.warning.main};
      opacity: 1;
    }
  `,
  promptContent: css`
    font-size: 13px;
    color: ${theme.colors.text.primary};
    flex: 1;
  `,
  arrowIcon: css`
    opacity: 0;
    transform: translateX(-10px);
    transition: all 0.2s;
    color: ${theme.colors.primary.text};
  `,
  preConfiguredActions: css`
    display: flex;
    align-items: center;
    gap: ${theme.spacing(1)};
  `,
  userPromptsContainer: css`
    display: flex;
    flex-direction: column;
    gap: ${theme.spacing(3)};
  `,
  actionsBar: css`
    display: flex;
    justify-content: flex-end;
  `,
  userPromptGrid: css`
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(300px, 1fr));
    gap: ${theme.spacing(2)};
  `,
  userPromptCard: css`
    background: ${theme.colors.background.secondary};
    border: 1px solid ${theme.colors.border.weak};
    border-radius: 8px;
    padding: ${theme.spacing(2)};
    cursor: pointer;
    transition: all 0.2s;
    display: flex;
    flex-direction: column;
    gap: ${theme.spacing(1)};
    height: 150px;

    &:hover {
      border-color: ${theme.colors.primary.border};
      box-shadow: ${theme.shadows.z2};
    }
  `,
  cardHeader: css`
    display: flex;
    justify-content: space-between;
    align-items: flex-start;
  `,
  cardTitle: css`
    font-weight: bold;
    font-size: 14px;
    margin: 0;
    color: ${theme.colors.text.primary};
  `,
  cardActions: css`
    display: flex;
    gap: ${theme.spacing(0.5)};
  `,
  cardContent: css`
    font-size: 12px;
    color: ${theme.colors.text.secondary};
    overflow: hidden;
    display: -webkit-box;
    -webkit-line-clamp: 4;
    -webkit-box-orient: vertical;
  `,
  iconButton: css`
    background: transparent;
    border: none;
    color: ${theme.colors.text.secondary};
    cursor: pointer;
    padding: 4px;
    border-radius: 4px;
    
    &:hover {
      background: ${theme.colors.background.primary};
      color: ${theme.colors.text.primary};
    }

    &.active {
      color: ${theme.colors.warning.main};
    }

    &.delete:hover {
      color: ${theme.colors.error.main};
    }
  `,
  modalActions: css`
    display: flex;
    justify-content: flex-end;
    gap: ${theme.spacing(1)};
    margin-top: ${theme.spacing(3)};
  `,
  errorBanner: css`
    background: ${theme.colors.error.main};
    color: ${theme.colors.error.contrastText};
    padding: ${theme.spacing(1)} ${theme.spacing(2)};
    border-radius: 4px;
    margin-bottom: ${theme.spacing(2)};
    display: flex;
    align-items: center;
    gap: ${theme.spacing(1)};
  `,
  pinnedBadge: css`
    font-size: 11px;
    color: ${theme.colors.warning.text};
    display: flex;
    align-items: center;
    gap: 4px;
    margin-top: auto;
    padding-top: ${theme.spacing(0.5)};
  `
});

