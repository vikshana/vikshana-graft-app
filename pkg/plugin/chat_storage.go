package plugin

import (
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strings"

	"github.com/grafana/grafana-plugin-sdk-go/backend/log"
	"github.com/grafana/grafana-plugin-sdk-go/backend/resource/httpadapter"
)

// chatHistoryPayload mirrors the frontend ChatHistory store.
type chatHistoryPayload struct {
	Sessions            []json.RawMessage `json:"sessions"`
	LastActiveSessionID string            `json:"lastActiveSessionId"`
}

func (a *App) chatStorageDir() string {
	base := os.Getenv("GF_PATHS_DATA")
	if base == "" {
		base = "/var/lib/grafana"
	}
	return filepath.Join(base, "plugins-storage", "vikshana-graft-app", "chat-history")
}

func userStorageKey(r *http.Request) (string, error) {
	cfg := httpadapter.PluginConfigFromContext(r.Context())
	login := "anonymous"
	if cfg.User != nil && cfg.User.Login != "" {
		login = cfg.User.Login
	}
	// Safe filename segment
	login = strings.Map(func(r rune) rune {
		if (r >= 'a' && r <= 'z') || (r >= 'A' && r <= 'Z') || (r >= '0' && r <= '9') || r == '-' || r == '_' || r == '.' {
			return r
		}
		return '_'
	}, login)
	return fmt.Sprintf("%d_%s.json", cfg.OrgID, login), nil
}

func (a *App) chatStoragePath(r *http.Request) (string, error) {
	key, err := userStorageKey(r)
	if err != nil {
		return "", err
	}
	return filepath.Join(a.chatStorageDir(), key), nil
}

func (a *App) readChatHistory(path string) (*chatHistoryPayload, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		if os.IsNotExist(err) {
			return &chatHistoryPayload{Sessions: []json.RawMessage{}}, nil
		}
		return nil, err
	}
	var payload chatHistoryPayload
	if err := json.Unmarshal(data, &payload); err != nil {
		return nil, err
	}
	if payload.Sessions == nil {
		payload.Sessions = []json.RawMessage{}
	}
	return &payload, nil
}

func (a *App) writeChatHistory(path string, payload *chatHistoryPayload) error {
	if err := os.MkdirAll(filepath.Dir(path), 0o750); err != nil {
		return err
	}
	data, err := json.Marshal(payload)
	if err != nil {
		return err
	}
	tmp := path + ".tmp"
	if err := os.WriteFile(tmp, data, 0o640); err != nil {
		return err
	}
	return os.Rename(tmp, path)
}

func (a *App) handleChatHistory(w http.ResponseWriter, r *http.Request) {
	path, err := a.chatStoragePath(r)
	if err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}

	a.chatMu.Lock()
	defer a.chatMu.Unlock()

	switch r.Method {
	case http.MethodPost:
		// Alias for PUT — some Grafana/BackendSrv clients route saves more reliably via POST.
		fallthrough
	case http.MethodPut:
		body, err := io.ReadAll(io.LimitReader(r.Body, 10*1024*1024))
		if err != nil {
			http.Error(w, "failed to read body", http.StatusBadRequest)
			return
		}
		var payload chatHistoryPayload
		if err := json.Unmarshal(body, &payload); err != nil {
			http.Error(w, "invalid json", http.StatusBadRequest)
			return
		}
		if payload.Sessions == nil {
			payload.Sessions = []json.RawMessage{}
		}
		if err := a.writeChatHistory(path, &payload); err != nil {
			log.DefaultLogger.Error("write chat history", "error", err, "path", path)
			http.Error(w, "failed to save chat history", http.StatusInternalServerError)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		w.Write([]byte(`{"ok":true}`))
	case http.MethodGet:
		payload, err := a.readChatHistory(path)
		if err != nil {
			log.DefaultLogger.Error("read chat history", "error", err, "path", path)
			http.Error(w, "failed to read chat history", http.StatusInternalServerError)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		if err := json.NewEncoder(w).Encode(payload); err != nil {
			log.DefaultLogger.Error("encode chat history", "error", err)
		}
	default:
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
	}
}
