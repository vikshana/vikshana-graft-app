// External libraries
import { useRef, useCallback, RefObject } from 'react';

/**
 * Return type for the auto-scroll hook
 */
interface UseAutoScrollReturn {
    messagesEndRef: RefObject<HTMLDivElement>;
    messageListRef: RefObject<HTMLDivElement>;
    scrollToBottom: (behavior?: ScrollBehavior) => void;
    handleScroll: () => void;
    scrollDownPage: () => void;
    showScrollButton: boolean;
    shouldAutoScroll: boolean;
    setShouldAutoScroll: (value: boolean) => void;
    setShowScrollButton: (value: boolean) => void;
}

/**
 * Props for the useAutoScroll hook
 */
interface UseAutoScrollProps {
    shouldAutoScroll: boolean;
    setShouldAutoScroll: (value: boolean) => void;
    showScrollButton: boolean;
    setShowScrollButton: (value: boolean) => void;
}

/**
 * Custom hook to handle auto-scrolling behavior for message lists
 * Manages scroll-to-bottom functionality and scroll button visibility
 * 
 * @param props Configuration for auto-scroll behavior
 * @returns Refs and handlers for auto-scroll functionality
 */
export const useAutoScroll = (props: UseAutoScrollProps): UseAutoScrollReturn => {
    const { shouldAutoScroll, setShouldAutoScroll, showScrollButton, setShowScrollButton } = props;

    const messageListRef = useRef<HTMLDivElement>(null);
    const messagesEndRef = useRef<HTMLDivElement>(null);

    const scrollToBottom = useCallback((behavior: ScrollBehavior = 'smooth') => {
        // Use requestAnimationFrame for smoother scrolling
        requestAnimationFrame(() => {
            messagesEndRef.current?.scrollIntoView({ behavior, block: 'end' });
        });
    }, []);

    const handleScroll = useCallback(() => {
        if (messageListRef.current) {
            const { scrollTop, scrollHeight, clientHeight } = messageListRef.current;
            const isAtBottom = Math.abs(scrollHeight - clientHeight - scrollTop) < 50;
            setShowScrollButton(!isAtBottom);
            // Track if user should auto-scroll based on their position
            setShouldAutoScroll(isAtBottom);
        }
    }, [setShowScrollButton, setShouldAutoScroll]);

    const scrollDownPage = useCallback(() => {
        if (messageListRef.current && typeof messageListRef.current.scrollTo === 'function') {
            const { scrollTop, clientHeight } = messageListRef.current;
            messageListRef.current.scrollTo({ top: scrollTop + clientHeight, behavior: 'smooth' });
        }
    }, []);

    return {
        messagesEndRef,
        messageListRef,
        scrollToBottom,
        handleScroll,
        scrollDownPage,
        showScrollButton,
        shouldAutoScroll,
        setShouldAutoScroll,
        setShowScrollButton,
    };
};
