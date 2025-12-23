// External libraries
import { useState, useEffect, useCallback, useRef } from 'react';

const PLACEHOLDER_TEXTS = [
    'Query Metrics, Logs and Traces ...',
    'Build, update and enhance your dashboards ...',
    'Perform Root Cause Analysis ...',
    'Create alerts and recording rules ...',
    'Refine your alerting templates ...',
    'Instrument code for better insights ...',
    'Validate your OpenTelemetry config ...',
] as const;

/**
 * Custom hook for rolling placeholder text animation
 * Cycles through a list of placeholder texts with typing and deleting animations
 *
 * @returns Current placeholder text to display
 */
export const useRollingPlaceholder = (): string => {
    const [currentText, setCurrentText] = useState('');
    const [currentIndex, setCurrentIndex] = useState(0);
    const stateRef = useRef({ isDeleting: false, isPaused: false });

    const tick = useCallback(() => {
        const { isDeleting, isPaused } = stateRef.current;
        const targetText = PLACEHOLDER_TEXTS[currentIndex];

        if (isPaused) {
            return;
        }

        if (!isDeleting && currentText === targetText) {
            // Finished typing, pause before deleting
            stateRef.current.isPaused = true;
            stateRef.current.isDeleting = true;
            return;
        }

        if (isDeleting && currentText === '') {
            // Finished deleting, pause before next text
            stateRef.current.isPaused = true;
            stateRef.current.isDeleting = false;
            setCurrentIndex((prev) => (prev + 1) % PLACEHOLDER_TEXTS.length);
            return;
        }

        if (isDeleting) {
            setCurrentText(currentText.substring(0, currentText.length - 1));
        } else {
            setCurrentText(targetText.substring(0, currentText.length + 1));
        }
    }, [currentText, currentIndex]);

    useEffect(() => {
        const { isDeleting, isPaused } = stateRef.current;

        if (isPaused) {
            const pauseDuration = isDeleting ? 2000 : 1000;
            const timeout = setTimeout(() => {
                stateRef.current.isPaused = false;
                tick();
            }, pauseDuration);
            return () => clearTimeout(timeout);
        }

        const timeout = setTimeout(tick, stateRef.current.isDeleting ? 50 : 80);
        return () => clearTimeout(timeout);
    }, [currentText, currentIndex, tick]);

    return currentText;
};
