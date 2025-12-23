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

    it('renders correctly and defaults to pre-configured tab', () => {
        render(<PromptLibrary />);
        expect(screen.getByText('Prompt Library')).toBeInTheDocument();
        expect(screen.getByText('Pre-configured Prompts')).toBeInTheDocument();
        expect(screen.getByText('My Prompts')).toBeInTheDocument();
        // Check for a known category from pre-configured prompts
        expect(screen.getByText('DATASOURCE QUERIES')).toBeInTheDocument();
    });

    it('switches to My Prompts tab', () => {
        render(<PromptLibrary />);
        fireEvent.click(screen.getByText('My Prompts'));
        expect(screen.getByText('Create New Prompt')).toBeInTheDocument();
    });

    it('navigates with prompt content when clicked', () => {
        render(<PromptLibrary />);
        // Find a prompt item (assuming "Show me the rate..." is in the data)
        const promptItem = screen.getByText(/Show me the rate/i);
        fireEvent.click(promptItem);

        expect(mockNavigate).toHaveBeenCalledWith('..', {
            state: { prompt: expect.stringContaining('Show me the rate') }
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

        // Search for something specific
        fireEvent.change(searchInput, { target: { value: 'Kubernetes' } });

        // Should show matching items
        expect(screen.getByText(/Kubernetes/i)).toBeInTheDocument();
        // Should hide non-matching items (this is a loose check, assuming "Show me the rate" doesn't contain "Kubernetes")
        expect(screen.queryByText('Show me the rate')).not.toBeInTheDocument();
    });

    it('should allow pinning preconfigured prompts', () => {
        (promptLibraryService.getPinnedPreConfiguredPrompts as jest.Mock).mockReturnValue([]);
        render(<PromptLibrary />);

        // Find a prompt item
        const promptText = /Show me the rate/i;
        screen.getByText(promptText);

        // Find the pin button associated with this prompt
        const pinButtons = screen.getAllByRole('button', { name: /Pin prompt/i });
        fireEvent.click(pinButtons[0]);

        expect(promptLibraryService.togglePreConfiguredPin).toHaveBeenCalled();
    });
});
