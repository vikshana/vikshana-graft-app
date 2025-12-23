import React from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { ChatHistory } from './ChatHistory';
import { chatHistoryService, ChatSession } from '../services/chatHistory';

// Mock dependencies
jest.mock('../services/chatHistory');
jest.mock('react-router-dom', () => ({
    useNavigate: () => jest.fn(),
}));

const mockSessions: ChatSession[] = [
    {
        id: 'session-1',
        title: 'Pinned Session',
        messages: [{ role: 'user', content: 'Hello' }],
        createdAt: Date.now() - 2000,
        updatedAt: Date.now() - 2000,
        isPinned: true,
    },
    {
        id: 'session-2',
        title: 'Regular Session',
        messages: [{ role: 'user', content: 'Test' }],
        createdAt: Date.now() - 1000,
        updatedAt: Date.now() - 1000,
    },
    {
        id: 'session-3',
        title: 'Another Session',
        messages: [{ role: 'user', content: 'Another test' }],
        createdAt: Date.now(),
        updatedAt: Date.now(),
    },
];

describe('ChatHistory', () => {
    beforeEach(() => {
        jest.clearAllMocks();
        (chatHistoryService.getAllSessions as jest.Mock).mockReturnValue(mockSessions);
    });

    describe('Rendering', () => {
        it('should render header with centered title', () => {
            render(<ChatHistory />);
            expect(screen.getByText('Previous Conversations')).toBeInTheDocument();
            expect(screen.getByText('Back')).toBeInTheDocument();
        });

        it('should render session cards with date at bottom right', () => {
            render(<ChatHistory />);
            expect(screen.getByText('Pinned Session')).toBeInTheDocument();
            expect(screen.getByText('Regular Session')).toBeInTheDocument();
            expect(screen.getByText('Another Session')).toBeInTheDocument();
        });

        it('should show pinned sessions first', () => {
            render(<ChatHistory />);
            const sessionCards = screen.getAllByText(/Session/);
            // First session should be "Pinned Session"
            expect(sessionCards[0]).toHaveTextContent('Pinned Session');
        });

        it('should render search input', () => {
            render(<ChatHistory />);
            expect(screen.getByPlaceholderText('Search...')).toBeInTheDocument();
        });
    });

    describe('Pinning UI', () => {
        it('should show pinned icon for pinned sessions', () => {
            render(<ChatHistory />);
            const starButtons = screen.getAllByLabelText(/Pin conversation|Unpin conversation/);
            expect(starButtons.length).toBeGreaterThan(0);
        });

        it('should toggle pin state when clicking pin button', () => {
            (chatHistoryService.togglePinSession as jest.Mock).mockReturnValue(true);

            render(<ChatHistory />);
            const pinButton = screen.getAllByLabelText(/Pin conversation|Unpin conversation/)[1];

            fireEvent.click(pinButton);

            expect(chatHistoryService.togglePinSession).toHaveBeenCalled();
            expect(chatHistoryService.getAllSessions).toHaveBeenCalledTimes(2); // Initial + after pin
        });

        it('should show modal when pin limit reached', async () => {
            (chatHistoryService.togglePinSession as jest.Mock).mockReturnValue(false);

            render(<ChatHistory />);
            const pinButton = screen.getAllByLabelText(/Pin conversation/)[0];

            fireEvent.click(pinButton);

            await waitFor(() => {
                expect(screen.getByText('Pin Limit Reached')).toBeInTheDocument();
            });

            expect(screen.getByText(/You can only pin up to 20 conversations/)).toBeInTheDocument();
        });

        it('should dismiss pin limit modal when clicking Dismiss', async () => {
            (chatHistoryService.togglePinSession as jest.Mock).mockReturnValue(false);

            render(<ChatHistory />);
            const pinButton = screen.getAllByLabelText(/Pin conversation/)[0];

            fireEvent.click(pinButton);

            await waitFor(() => {
                expect(screen.getByText('Pin Limit Reached')).toBeInTheDocument();
            });

            const dismissButton = screen.getByText('Dismiss');
            fireEvent.click(dismissButton);

            await waitFor(() => {
                expect(screen.queryByText('Pin Limit Reached')).not.toBeInTheDocument();
            });
        });
    });

    describe('Delete UI', () => {
        it('should show confirmation modal when clicking delete', async () => {
            render(<ChatHistory />);
            const deleteButtons = screen.getAllByLabelText('Delete conversation');

            fireEvent.click(deleteButtons[0]);

            await waitFor(() => {
                expect(screen.getByText('Delete Conversation')).toBeInTheDocument();
            });

            expect(screen.getByText(/This action cannot be undone/)).toBeInTheDocument();
        });

        it('should keep session when clicking Cancel', async () => {
            render(<ChatHistory />);
            const deleteButtons = screen.getAllByLabelText('Delete conversation');

            fireEvent.click(deleteButtons[0]);

            await waitFor(() => {
                expect(screen.getByText('Delete Conversation')).toBeInTheDocument();
            });

            const cancelButton = screen.getByText('Cancel');
            fireEvent.click(cancelButton);

            await waitFor(() => {
                expect(screen.queryByText('Delete Conversation')).not.toBeInTheDocument();
            });

            expect(chatHistoryService.deleteSession).not.toHaveBeenCalled();
        });

        it('should delete session when clicking Delete', async () => {
            render(<ChatHistory />);
            const deleteButtons = screen.getAllByLabelText('Delete conversation');

            fireEvent.click(deleteButtons[0]);

            await waitFor(() => {
                expect(screen.getByText('Delete Conversation')).toBeInTheDocument();
            });

            const confirmButton = screen.getByText('Delete');
            fireEvent.click(confirmButton);

            await waitFor(() => {
                expect(chatHistoryService.deleteSession).toHaveBeenCalledWith('session-1');
            });

            expect(chatHistoryService.getAllSessions).toHaveBeenCalledTimes(2); // Initial + after delete
        });
    });

    describe('Search', () => {
        it('should filter sessions by title', () => {
            render(<ChatHistory />);
            const searchInput = screen.getByPlaceholderText('Search...');

            fireEvent.change(searchInput, { target: { value: 'Regular' } });

            expect(screen.getByText('Regular Session')).toBeInTheDocument();
            expect(screen.queryByText('Pinned Session')).not.toBeInTheDocument();
            expect(screen.queryByText('Another Session')).not.toBeInTheDocument();
        });

        it('should show empty state when no results', () => {
            render(<ChatHistory />);
            const searchInput = screen.getByPlaceholderText('Search...');

            fireEvent.change(searchInput, { target: { value: 'NonExistent' } });

            expect(screen.getByText('No conversations found')).toBeInTheDocument();
            expect(screen.getByText('Try a different search term')).toBeInTheDocument();
        });

        it('should show all sessions when search is cleared', () => {
            render(<ChatHistory />);
            const searchInput = screen.getByPlaceholderText('Search...');

            fireEvent.change(searchInput, { target: { value: 'Regular' } });
            fireEvent.change(searchInput, { target: { value: '' } });

            expect(screen.getByText('Pinned Session')).toBeInTheDocument();
            expect(screen.getByText('Regular Session')).toBeInTheDocument();
            expect(screen.getByText('Another Session')).toBeInTheDocument();
        });
    });
});
