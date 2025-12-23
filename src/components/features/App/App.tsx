// External libraries
import React, { lazy, Suspense, useEffect } from 'react';
import { Route, Routes } from 'react-router-dom';

// Grafana packages
import { AppRootProps } from '@grafana/data';
import { useStyles2, LoadingPlaceholder } from '@grafana/ui';
import { css } from '@emotion/css';

// Local utilities
import { initOtel } from '../../../utils/otel';
import { promptLibraryService } from '../../../services/promptLibrary';
import { CategoryDef } from '../../../types/prompt.types';

// Local components
import { ErrorBoundary } from '../../ErrorBoundary';

// Lazy loaded route components
const ChatInterface = lazy(() => import('../ChatInterface/ChatInterface').then(m => ({ default: m.ChatInterface })));
const ChatHistory = lazy(() => import('../../../pages/ChatHistory').then(m => ({ default: m.ChatHistory })));
const PromptLibrary = lazy(() => import('../../../pages/PromptLibrary').then(m => ({ default: m.PromptLibrary })));


export default function App(props: AppRootProps) {
  const styles = useStyles2(getStyles);

  useEffect(() => {
    initOtel();
    document.title = 'Graft AI Assistant';

    // Initialize prompt library with configured prompts
    const promptLibrarySettings = props.meta.jsonData?.promptLibrary as CategoryDef[] | undefined;
    if (promptLibrarySettings) {
      promptLibraryService.setConfiguredPrompts(promptLibrarySettings);
    }
  }, [props.meta.jsonData]);

  return (
    <div className={styles.container}>
      <ErrorBoundary>
        <Suspense fallback={<LoadingPlaceholder text="Loading..." />}>
          <Routes>
            {/* Default page - Chat Interface */}
            <Route path="/" element={<ChatInterface />} />

            {/* Chat History Page */}
            <Route path="/history" element={<ChatHistory />} />

            {/* Prompt Library Page */}
            <Route path="/prompts" element={<PromptLibrary />} />

            {/* Fallback */}
            <Route path="*" element={<ChatInterface />} />
          </Routes>
        </Suspense>
      </ErrorBoundary>
    </div>
  );
}

const getStyles = () => ({
  container: css`
    position: relative;
    height: 100%;
    width: 100%;
  `,
});
