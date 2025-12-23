// External libraries
import React, { useState } from 'react';
import { useNavigate } from 'react-router-dom';

// Grafana packages
import { useStyles2, Input, Icon, Button, ConfirmModal, Modal } from '@grafana/ui';


// Local services
import { chatHistoryService, ChatSession } from '../services/chatHistory';
import { getStyles } from './ChatHistory.styles';


export const ChatHistory = () => {
  const styles = useStyles2(getStyles);
  const navigate = useNavigate();
  const [sessions, setSessions] = useState<ChatSession[]>(() => chatHistoryService.getAllSessions());
  const [searchQuery, setSearchQuery] = useState('');
  const [deleteModalOpen, setDeleteModalOpen] = useState(false);
  const [sessionToDelete, setSessionToDelete] = useState<string | null>(null);
  const [pinLimitModalOpen, setPinLimitModalOpen] = useState(false);

  // Bulk delete state
  const [selectionMode, setSelectionMode] = useState(false);
  const [selectedSessionIds, setSelectedSessionIds] = useState<Set<string>>(new Set());

  const handleLoadChat = (session: ChatSession) => {
    if (selectionMode) {
      toggleSessionSelection(session.id);
      return;
    }
    // Navigate back to main page with the session ID as a query param
    navigate(`../?chat=true&session=${session.id}`, { state: { returnTo: 'history' } });
  };

  const toggleSessionSelection = (sessionId: string) => {
    setSelectedSessionIds(prev => {
      const newSet = new Set(prev);
      if (newSet.has(sessionId)) {
        newSet.delete(sessionId);
      } else {
        newSet.add(sessionId);
      }
      return newSet;
    });
  };

  const toggleSelectAll = () => {
    if (selectedSessionIds.size === filteredSessions.length) {
      setSelectedSessionIds(new Set());
    } else {
      setSelectedSessionIds(new Set(filteredSessions.map(s => s.id)));
    }
  };

  const handleBulkDelete = () => {
    if (selectedSessionIds.size === 0) {return;}
    setDeleteModalOpen(true);
  };

  const onDeleteClick = (sessionId: string) => {
    setSessionToDelete(sessionId);
    setDeleteModalOpen(true);
  };

  const confirmDelete = () => {
    if (sessionToDelete) {
      chatHistoryService.deleteSession(sessionToDelete);
      setSessionToDelete(null);
    } else if (selectionMode && selectedSessionIds.size > 0) {
      // Bulk delete
      selectedSessionIds.forEach(id => chatHistoryService.deleteSession(id));
      setSelectedSessionIds(new Set());
      setSelectionMode(false);
    }

    setSessions(chatHistoryService.getAllSessions());
    setDeleteModalOpen(false);
  };

  const cancelDelete = () => {
    setDeleteModalOpen(false);
    setSessionToDelete(null);
  };

  const handleTogglePin = (e: React.MouseEvent, sessionId: string) => {
    e.stopPropagation();
    const success = chatHistoryService.togglePinSession(sessionId);
    if (success) {
      setSessions(chatHistoryService.getAllSessions());
    } else {
      setPinLimitModalOpen(true);
    }
  };

  const filteredSessions = sessions.filter(session =>
    session.title.toLowerCase().includes(searchQuery.toLowerCase())
  );

  // Separate pinned and unpinned sessions
  const pinnedSessions = filteredSessions
    .filter(s => s.isPinned)
    .sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime());

  const unpinnedSessions = filteredSessions
    .filter(s => !s.isPinned)
    .sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime());

  return (
    <div className={styles.container}>
      <div className={styles.header}>
        <div className={styles.headerLeft}>
          <Button variant="secondary" fill="outline" icon="arrow-left" onClick={() => navigate('..')} data-testid="back-button">
            Back
          </Button>
        </div>

        {selectionMode ? (
          <div className={styles.selectionToolbar}>
            <span className={styles.selectionCount}>
              {selectedSessionIds.size} selected
            </span>
            <div className={styles.selectionActions}>
              <Button variant="secondary" fill="text" onClick={toggleSelectAll}>
                {selectedSessionIds.size === filteredSessions.length ? 'Deselect All' : 'Select All'}
              </Button>
              <Button
                variant="destructive"
                fill="solid"
                icon="trash-alt"
                onClick={handleBulkDelete}
                disabled={selectedSessionIds.size === 0}
              >
                Delete
              </Button>
              <Button variant="secondary" fill="text" onClick={() => {
                setSelectionMode(false);
                setSelectedSessionIds(new Set());
              }}>
                Cancel
              </Button>
            </div>
          </div>
        ) : (
          <>
            <h1 className={styles.title}>Previous Conversations</h1>
            <div className={styles.headerActions}>
              <Button
                variant="secondary"
                fill="text"
                icon="check-square"
                onClick={() => setSelectionMode(true)}
                disabled={filteredSessions.length === 0}
              >
                Select
              </Button>
              <div className={styles.searchWrapper}>
                <Input
                  placeholder="Search..."
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.currentTarget.value)}
                  prefix={<Icon name="search" />}
                  data-testid="history-search-input"
                />
              </div>
            </div>
          </>
        )}
      </div>

      <Modal
        isOpen={pinLimitModalOpen}
        title="Pin Limit Reached"
        onDismiss={() => setPinLimitModalOpen(false)}
      >
        <p>You can only pin up to 20 conversations. Please unpin some items to pin new ones.</p>
        <Modal.ButtonRow>
          <Button onClick={() => setPinLimitModalOpen(false)}>Dismiss</Button>
        </Modal.ButtonRow>
      </Modal>

      <ConfirmModal
        isOpen={deleteModalOpen}
        title="Delete Conversation"
        body="Are you sure you want to delete this conversation? This action cannot be undone."
        confirmText="Delete"
        onConfirm={confirmDelete}
        onDismiss={cancelDelete}
      />

      <div className={styles.content}>
        {filteredSessions.length === 0 ? (
          <div className={styles.emptyState}>
            <div className={styles.emptyIcon}>💬</div>
            <div className={styles.emptyTitle}>
              {searchQuery ? 'No conversations found' : 'No chat history yet'}
            </div>
            <div className={styles.emptyDesc}>
              {searchQuery
                ? 'Try a different search term'
                : 'Start a new conversation to see your history here'}
            </div>
          </div>
        ) : (
          <>
            {pinnedSessions.length > 0 && (
              <>
                <div className={styles.sectionHeader}>
                  <Icon name="star" type="solid" />
                  <span>Pinned Conversations</span>
                </div>
                <div className={styles.sessionGrid}>
                  {pinnedSessions.map((session) => (
                    <div
                      key={session.id}
                      className={`${styles.sessionCard} ${selectionMode ? styles.sessionSelectable : ''} ${selectedSessionIds.has(session.id) ? styles.sessionSelected : ''}`}
                      onClick={() => handleLoadChat(session)}
                      data-testid="session-card"
                    >
                      {selectionMode && (
                        <div className={styles.sessionCheckbox} onClick={(e) => e.stopPropagation()}>
                          <input
                            type="checkbox"
                            checked={selectedSessionIds.has(session.id)}
                            onChange={() => toggleSessionSelection(session.id)}
                          />
                        </div>
                      )}
                      <div className={styles.cardHeader}>
                        <span className={styles.chatIcon}>💬</span>
                      </div>
                      <div className={styles.cardTitle}>{session.title}</div>
                      <div className={styles.cardPreview}>
                        {session.messages[0]?.content.substring(0, 100)}...
                      </div>
                      <span className={styles.cardDate}>
                        {new Date(session.updatedAt).toLocaleDateString()}
                      </span>
                      {!selectionMode && (
                        <>
                          <button
                            className={`${styles.pinBtn} ${session.isPinned ? styles.pinned : ''}`}
                            onClick={(e) => handleTogglePin(e, session.id)}
                            aria-label={session.isPinned ? "Unpin conversation" : "Pin conversation"}
                          >
                            <Icon name={session.isPinned ? "star" : "star"} type={session.isPinned ? "solid" : "default"} size="sm" />
                          </button>
                          <button
                            className={styles.deleteBtn}
                            onClick={(e) => {
                              e.stopPropagation();
                              onDeleteClick(session.id);
                            }}
                            aria-label="Delete conversation"
                          >
                            <Icon name="trash-alt" size="sm" />
                          </button>
                        </>
                      )}
                    </div>
                  ))}
                </div>
                {unpinnedSessions.length > 0 && <div className={styles.divider} />}
              </>
            )}
            {unpinnedSessions.length > 0 && (
              <>
                {pinnedSessions.length > 0 && (
                  <div className={styles.sectionHeader}>
                    <Icon name="history" />
                    <span>Recent Conversations</span>
                  </div>
                )}
                <div className={styles.sessionGrid}>
                  {unpinnedSessions.map((session) => (
                    <div
                      key={session.id}
                      className={`${styles.sessionCard} ${selectionMode ? styles.sessionSelectable : ''} ${selectedSessionIds.has(session.id) ? styles.sessionSelected : ''}`}
                      onClick={() => handleLoadChat(session)}
                      data-testid="session-card"
                    >
                      {selectionMode && (
                        <div className={styles.sessionCheckbox} onClick={(e) => e.stopPropagation()}>
                          <input
                            type="checkbox"
                            checked={selectedSessionIds.has(session.id)}
                            onChange={() => toggleSessionSelection(session.id)}
                          />
                        </div>
                      )}
                      <div className={styles.cardHeader}>
                        <span className={styles.chatIcon}>💬</span>
                      </div>
                      <div className={styles.cardTitle}>{session.title}</div>
                      <div className={styles.cardPreview}>
                        {session.messages[0]?.content.substring(0, 100)}...
                      </div>
                      <span className={styles.cardDate}>
                        {new Date(session.updatedAt).toLocaleDateString()}
                      </span>
                      {!selectionMode && (
                        <>
                          <button
                            className={`${styles.pinBtn} ${session.isPinned ? styles.pinned : ''}`}
                            onClick={(e) => handleTogglePin(e, session.id)}
                            aria-label={session.isPinned ? "Unpin conversation" : "Pin conversation"}
                          >
                            <Icon name={session.isPinned ? "star" : "star"} type={session.isPinned ? "solid" : "default"} size="sm" />
                          </button>
                          <button
                            className={styles.deleteBtn}
                            onClick={(e) => {
                              e.stopPropagation();
                              onDeleteClick(session.id);
                            }}
                            aria-label="Delete conversation"
                          >
                            <Icon name="trash-alt" size="sm" />
                          </button>
                        </>
                      )}
                    </div>
                  ))}
                </div>
              </>
            )}
          </>
        )}
      </div>
    </div>
  );
};
