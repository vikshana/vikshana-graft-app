// External libraries
import React, { useState } from 'react';
import { useNavigate } from 'react-router-dom';

// Grafana packages
import { useStyles2, Button, Input, Icon, TabsBar, Tab, Modal, TextArea, Field, ConfirmModal, Select } from '@grafana/ui';
// Local services and data
import { getStyles } from './PromptLibrary.styles';
import { promptLibraryService, UserPrompt } from '../services/promptLibrary';


export const PromptLibrary = () => {
  const styles = useStyles2(getStyles);
  const navigate = useNavigate();
  const [activeTab, setActiveTab] = useState<'preconfigured' | 'user'>('preconfigured');
  const [searchQuery, setSearchQuery] = useState('');
  const [userPrompts, setUserPrompts] = useState<UserPrompt[]>(() => promptLibraryService.getUserPromptsSorted());
  const [isModalOpen, setIsModalOpen] = useState(false);
  const [editingPrompt, setEditingPrompt] = useState<Partial<UserPrompt>>({});
  const [deleteId, setDeleteId] = useState<string | null>(null);
  const [pinError, setPinError] = useState<string | null>(null);
  const [categories, setCategories] = useState<string[]>(() => promptLibraryService.getCategories());
  const [pinnedPreConfigured, setPinnedPreConfigured] = useState<string[]>(() => promptLibraryService.getPinnedPreConfiguredPrompts());
  // Add state for pre-configured prompts to make it reactive
  const [preConfiguredPrompts, setPreConfiguredPrompts] = useState(() => {
    return promptLibraryService.getPreConfiguredPrompts();
  });

  // Reload pre-configured prompts when component mounts
  React.useEffect(() => {
    const prompts = promptLibraryService.getPreConfiguredPrompts();
    setPreConfiguredPrompts(prompts);
  }, []);

  const loadUserPrompts = () => {
    setUserPrompts(promptLibraryService.getUserPromptsSorted());
    setCategories(promptLibraryService.getCategories());
  };

  const handleUsePrompt = (content: string) => {
    navigate('..', { state: { prompt: content } });
  };

  const handleSavePrompt = () => {
    if (!editingPrompt.title || !editingPrompt.content) {
      return;
    }

    promptLibraryService.saveUserPrompt(editingPrompt as any);
    setIsModalOpen(false);
    setEditingPrompt({});
    loadUserPrompts();
  };

  const handleDeletePrompt = () => {
    if (deleteId) {
      promptLibraryService.deleteUserPrompt(deleteId);
      setDeleteId(null);
      loadUserPrompts();
    }
  };

  const handleTogglePin = (e: React.MouseEvent, id: string) => {
    e.stopPropagation();
    try {
      promptLibraryService.togglePin(id);
      loadUserPrompts();
      setPinError(null);
    } catch (err: any) {
      setPinError(err.message);
      setTimeout(() => setPinError(null), 3000);
    }
  };

  const handleTogglePreConfiguredPin = (e: React.MouseEvent, content: string) => {
    e.stopPropagation();
    try {
      promptLibraryService.togglePreConfiguredPin(content);
      setPinnedPreConfigured(promptLibraryService.getPinnedPreConfiguredPrompts());
      setPinError(null);
    } catch (err: any) {
      setPinError(err.message);
      setTimeout(() => setPinError(null), 3000);
    }
  };

  const filteredPreConfigured = Object.entries(preConfiguredPrompts).reduce((acc, [category, subCats]) => {
    const filteredSubCats = Object.entries(subCats).reduce((subAcc, [subCat, prompts]) => {
      const filteredPrompts = prompts.filter(p =>
        p.toLowerCase().includes(searchQuery.toLowerCase()) ||
        category.toLowerCase().includes(searchQuery.toLowerCase()) ||
        subCat.toLowerCase().includes(searchQuery.toLowerCase())
      );
      if (filteredPrompts.length > 0) {
        // Sort: Pinned first, then alphabetical
        subAcc[subCat] = filteredPrompts.sort((a, b) => {
          const isPinnedA = pinnedPreConfigured.includes(a);
          const isPinnedB = pinnedPreConfigured.includes(b);
          if (isPinnedA === isPinnedB) {return a.localeCompare(b);}
          return isPinnedA ? -1 : 1;
        });
      }
      return subAcc;
    }, {} as Record<string, string[]>);

    if (Object.keys(filteredSubCats).length > 0) {
      acc[category] = filteredSubCats;
    }
    return acc;
  }, {} as Record<string, Record<string, string[]>>);

  const filteredUserPrompts = userPrompts.filter(p =>
    p.title.toLowerCase().includes(searchQuery.toLowerCase()) ||
    p.content.toLowerCase().includes(searchQuery.toLowerCase()) ||
    (p.category && p.category.toLowerCase().includes(searchQuery.toLowerCase()))
  );

  // Group user prompts by category
  const groupedUserPrompts = filteredUserPrompts.reduce((acc, prompt) => {
    const category = prompt.category || 'Uncategorized';
    if (!acc[category]) {
      acc[category] = [];
    }
    acc[category].push(prompt);
    return acc;
  }, {} as Record<string, UserPrompt[]>);

  // Sort categories: Uncategorized last, others alphabetically
  const sortedCategories = Object.keys(groupedUserPrompts).sort((a, b) => {
    if (a === 'Uncategorized') {return 1;}
    if (b === 'Uncategorized') {return -1;}
    return a.localeCompare(b);
  });

  return (
    <div className={styles.container}>
      <div className={styles.stickySection}>
        <div className={styles.header}>
          <div className={styles.headerLeft}>
            <Button variant="secondary" fill="outline" icon="arrow-left" onClick={() => navigate('..')}>
              Back
            </Button>
          </div>
          <div className={styles.title}>Prompt Library</div>
          <div className={styles.headerRight}>
            <Input
              prefix={<Icon name="search" />}
              placeholder="Search prompts..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.currentTarget.value)}
              width={40}
            />
          </div>
        </div>
        <TabsBar className={styles.tabs}>
          <Tab
            label="Pre-configured Prompts"
            active={activeTab === 'preconfigured'}
            onChangeTab={() => setActiveTab('preconfigured')}
            icon="book"
          />
          <Tab
            label="My Prompts"
            active={activeTab === 'user'}
            onChangeTab={() => setActiveTab('user')}
            icon="user"
          />
        </TabsBar>
      </div>

      <div className={styles.content}>
        {pinError && (
          <div className={styles.errorBanner}>
            <Icon name="exclamation-triangle" /> {pinError}
          </div>
        )}

        {activeTab === 'preconfigured' ? (
          <div className={styles.promptGrid}>
            {Object.entries(filteredPreConfigured).map(([category, subCats]) => (
              <div key={category} className={styles.categorySection}>
                <h2 className={styles.categoryTitle}>{category.replace('_', ' ').toUpperCase()}</h2>
                <div className={styles.subCategoryGrid}>
                  {Object.entries(subCats).map(([subCat, prompts]) => (
                    <div key={subCat} className={styles.subCategoryCard}>
                      <h3 className={styles.subCategoryTitle}>{subCat.replace('_', ' ')}</h3>
                      <div className={styles.promptList}>
                        {prompts.map((prompt, idx) => (
                          <div
                            key={idx}
                            className={styles.promptItem}
                            data-testid="pre-configured-prompt-item"
                            onClick={() => handleUsePrompt(prompt)}
                          >
                            <div className={styles.promptContent} data-testid="prompt-content">{prompt}</div>
                            <button
                              className={`${styles.pinButton} ${pinnedPreConfigured.includes(prompt) ? 'active' : ''}`}
                              onClick={(e) => handleTogglePreConfiguredPin(e, prompt)}
                              title={pinnedPreConfigured.includes(prompt) ? "Unpin prompt" : "Pin prompt"}
                            >
                              <Icon name={pinnedPreConfigured.includes(prompt) ? "star" : "star"} type={pinnedPreConfigured.includes(prompt) ? "solid" : "default"} />
                            </button>
                            <Icon name="arrow-right" className={styles.arrowIcon} />
                          </div>
                        ))}
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            ))}
          </div>
        ) : (
          <div className={styles.userPromptsContainer}>
            <div className={styles.actionsBar}>
              <Button icon="plus" onClick={() => {
                setEditingPrompt({});
                setIsModalOpen(true);
              }}>
                Create New Prompt
              </Button>
            </div>

            <div className={styles.promptGrid}>
              {sortedCategories.map(category => (
                <div key={category} className={styles.categorySection}>
                  <h2 className={styles.categoryTitle}>{category}</h2>
                  <div className={styles.userPromptGrid}>
                    {groupedUserPrompts[category].map(prompt => (
                      <div key={prompt.id} className={styles.userPromptCard} data-testid="user-prompt-card" onClick={() => handleUsePrompt(prompt.content)}>
                        <div className={styles.cardHeader}>
                          <h3 className={styles.cardTitle}>{prompt.title}</h3>
                          <div className={styles.cardActions}>
                            <button
                              className={`${styles.iconButton} ${prompt.isPinned ? 'active' : ''}`}
                              onClick={(e) => handleTogglePin(e, prompt.id)}
                              title={prompt.isPinned ? "Unpin prompt" : "Pin prompt"}
                            >
                              <Icon name={prompt.isPinned ? "star" : "star"} type={prompt.isPinned ? "solid" : "default"} />
                            </button>
                            <button
                              className={styles.iconButton}
                              onClick={(e) => {
                                e.stopPropagation();
                                setEditingPrompt(prompt);
                                setIsModalOpen(true);
                              }}
                            >
                              <Icon name="pen" />
                            </button>
                            <button
                              className={`${styles.iconButton} delete`}
                              title="Delete prompt"
                              onClick={(e) => {
                                e.stopPropagation();
                                setDeleteId(prompt.id);
                              }}
                            >
                              <Icon name="trash-alt" />
                            </button>
                          </div>
                        </div>
                        <div className={styles.cardContent}>{prompt.content}</div>
                        {prompt.isPinned && <div className={styles.pinnedBadge}><Icon name="star" type="solid" /> Pinned</div>}
                      </div>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>

      <Modal
        isOpen={isModalOpen}
        title={editingPrompt.id ? "Edit Prompt" : "Create Prompt"}
        onDismiss={() => setIsModalOpen(false)}
      >
        <Field label="Title">
          <Input
            value={editingPrompt.title || ''}
            onChange={e => setEditingPrompt({ ...editingPrompt, title: e.currentTarget.value })}
            placeholder="e.g., Debug K8s Pods"
          />
        </Field>
        <Field label="Category" description="Select an existing category or create a new one">
          <Select
            options={categories.map(c => ({ label: c, value: c }))}
            value={editingPrompt.category}
            onChange={(option) => {
              setEditingPrompt({ ...editingPrompt, category: option?.value });
            }}
            onCreateOption={(value: string) => {
              // Add the new category to the list
              setCategories([...categories, value].sort());
              setEditingPrompt({ ...editingPrompt, category: value });
            }}
            placeholder="Select or create category"
            isClearable
            allowCustomValue
            width={40}
          />
        </Field>
        <Field label="Prompt Content">
          <TextArea
            value={editingPrompt.content || ''}
            onChange={e => setEditingPrompt({ ...editingPrompt, content: e.currentTarget.value })}
            placeholder="Enter your prompt here..."
            rows={5}
          />
        </Field>
        <div className={styles.modalActions}>
          <Button variant="secondary" onClick={() => setIsModalOpen(false)}>Cancel</Button>
          <Button onClick={handleSavePrompt}>Save</Button>
        </div>
      </Modal>

      <ConfirmModal
        isOpen={!!deleteId}
        title="Delete Prompt"
        body="Are you sure you want to delete this prompt? This action cannot be undone."
        confirmText="Delete"
        onConfirm={handleDeletePrompt}
        onDismiss={() => setDeleteId(null)}
      />
    </div>
  );
};
