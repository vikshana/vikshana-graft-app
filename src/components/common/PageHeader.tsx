import React from 'react';
import { useNavigate } from 'react-router-dom';
import { Button, useStyles2 } from '@grafana/ui';
import { getStyles } from './PageHeader.styles';

interface PageHeaderProps {
  title: string;
  /** navigate target — relative ('..' ) or absolute prefixed route */
  backTo?: string;
  /** override back navigation with a callback instead */
  onBack?: () => void;
  /** right-side slot: action buttons, badges, status indicators */
  actions?: React.ReactNode;
}

export function PageHeader({ title, backTo, onBack, actions }: PageHeaderProps) {
  const styles = useStyles2(getStyles);
  const navigate = useNavigate();

  const handleBack = onBack ?? (() => navigate(backTo ?? '..'));

  return (
    <div className={styles.header}>
      <div className={styles.left}>
        <Button variant="secondary" fill="outline" icon="arrow-left" onClick={handleBack}>
          Back
        </Button>
      </div>
      <div className={styles.center}>
        <h1 className={styles.title}>{title}</h1>
      </div>
      <div className={styles.right}>
        {actions}
      </div>
    </div>
  );
}
