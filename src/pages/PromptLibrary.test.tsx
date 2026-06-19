import React from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { PromptLibrary } from './PromptLibrary';
import { promptLibraryService } from '../services/promptLibrary';

// Mock dependencies
const mockNavigate = jest.fn();
jest.mock('react-router-dom', () => ({
    useNavigate: () => mockNavigate,
}));

jest.mock('../services/promptLibrary');

// Default preconfigured prompts for testing
const mockPreConfiguredPrompts = {
    'DATASOURCE QUERIES': {
        'Prometheus': [
            'Show me the rate of errors in the last hour',
            'Query Kubernetes pod metrics'
        ]
    }
};

describe('PromptLibrary', () => {
    beforeEach(() => {
        jest.clearAllMocks();
        (promptLibraryService.getUserPrompts as jest.Mock).mockReturnValue([]);
        (promptLibraryService.getCategories as jest.Mock).mockReturnValue([]);
        (promptLibraryService.getPinnedPreConfiguredPrompts as jest.Mock).mockReturnValue([]);
        (promptLibraryService.getUserPromptsSorted as jest.Mock).mockReturnValue([]);
        (promptLibraryService.getPreConfiguredPrompts as jest.Mock).mockReturnValue(mockPreConfiguredPrompts);
    });

    it('renders correctly and defaults to suggested tab', () => {
        render(<PromptLibrary />);
        expect(screen.getByText('Prompt Library')).toBeInTheDocument();
        expect(screen.getByText('Suggested Prompts')).toBeInTheDocument();
        expect(screen.getByText('Pre-configured Prompts')).toBeInTheDocument();
        expect(screen.getByText('My Prompts')).toBeInTheDocument();
        expect(screen.getByText('Rename machine dashboard')).toBeInTheDocument();
    });

    it('switches to pre-configured tab', () => {
        render(<PromptLibrary />);
        fireEvent.click(screen.getByText('Pre-configured Prompts'));
        expect(screen.getByText('DATASOURCE QUERIES')).toBeInTheDocument();
    });

    it('switches to My Prompts tab', () => {
        render(<PromptLibrary />);
        fireEvent.click(screen.getByText('My Prompts'));
        expect(screen.getByText('Create New Prompt')).toBeInTheDocument();
    });

    it('navigates with prompt content when clicked', () => {
        render(<PromptLibrary />);
        const promptItem = screen.getByText('Rename machine dashboard');
        fireEvent.click(promptItem);

        expect(mockNavigate).toHaveBeenCalledWith('..', {
            state: {
                prompt: expect.stringContaining('Rename the dashboard for the 2505-200033 machine'),
                autoSend: true,
            },
        });
    });

    it('opens modal when Create New Prompt is clicked', () => {
        render(<PromptLibrary />);
        fireEvent.click(screen.getByText('My Prompts'));
        fireEvent.click(screen.getByText('Create New Prompt'));

        expect(screen.getByText('Create Prompt')).toBeInTheDocument();
        expect(screen.getByPlaceholderText('e.g., Debug K8s Pods')).toBeInTheDocument();
    });

    it('saves a new user prompt', async () => {
        (promptLibraryService.saveUserPrompt as jest.Mock).mockReturnValue({ id: '123' });

        render(<PromptLibrary />);
        fireEvent.click(screen.getByText('My Prompts'));
        fireEvent.click(screen.getByText('Create New Prompt'));

        fireEvent.change(screen.getByPlaceholderText('e.g., Debug K8s Pods'), { target: { value: 'New Prompt' } });
        fireEvent.change(screen.getByPlaceholderText('Enter your prompt here...'), { target: { value: 'New Content' } });

        fireEvent.click(screen.getByText('Save'));

        await waitFor(() => {
            expect(promptLibraryService.saveUserPrompt).toHaveBeenCalledWith(expect.objectContaining({
                title: 'New Prompt',
                content: 'New Content'
            }));
        });
    });

    it('filters prompts based on search query', () => {
        render(<PromptLibrary />);
        const searchInput = screen.getByPlaceholderText('Search prompts...');

        fireEvent.change(searchInput, { target: { value: 'peer band' } });

        expect(screen.getByText('Fix all vs. Peer Band panels')).toBeInTheDocument();
        expect(screen.queryByText('Rename machine dashboard')).not.toBeInTheDocument();
    });

    it('should allow pinning suggested prompts', () => {
        (promptLibraryService.getPinnedPreConfiguredPrompts as jest.Mock).mockReturnValue([]);
        render(<PromptLibrary />);

        const pinButtons = screen.getAllByRole('button', { name: /Pin prompt/i });
        fireEvent.click(pinButtons[0]);

        expect(promptLibraryService.togglePreConfiguredPin).toHaveBeenCalled();
    });

    it('should allow pinning preconfigured prompts', () => {
        (promptLibraryService.getPinnedPreConfiguredPrompts as jest.Mock).mockReturnValue([]);
        render(<PromptLibrary />);
        fireEvent.click(screen.getByText('Pre-configured Prompts'));

        const pinButtons = screen.getAllByRole('button', { name: /Pin prompt/i });
        fireEvent.click(pinButtons[0]);

        expect(promptLibraryService.togglePreConfiguredPin).toHaveBeenCalled();
    });
});
