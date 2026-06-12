// External libraries
import { useState, useEffect, useRef } from 'react';

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
    const isDeletingRef = useRef(false);

    useEffect(() => {
        const targetText = PLACEHOLDER_TEXTS[currentIndex];
        const isDeleting = isDeletingRef.current;

        if (!isDeleting && currentText === targetText) {
            // Finished typing, pause before deleting
            const timeout = setTimeout(() => {
                isDeletingRef.current = true;
                setCurrentText(targetText.substring(0, targetText.length - 1));
            }, 2000);
            return () => clearTimeout(timeout);
        }

        if (isDeleting && currentText === '') {
            // Finished deleting, pause before next text
            const timeout = setTimeout(() => {
                isDeletingRef.current = false;
                setCurrentIndex((prev) => (prev + 1) % PLACEHOLDER_TEXTS.length);
            }, 1000);
            return () => clearTimeout(timeout);
        }

        const delay = isDeleting ? 50 : 80;
        const timeout = setTimeout(() => {
            if (isDeleting) {
                setCurrentText(currentText.substring(0, currentText.length - 1));
            } else {
                setCurrentText(targetText.substring(0, currentText.length + 1));
            }
        }, delay);
        return () => clearTimeout(timeout);
    }, [currentText, currentIndex]);

    return currentText;
};
