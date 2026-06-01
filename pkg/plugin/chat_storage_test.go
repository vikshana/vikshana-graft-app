package plugin

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"

	"github.com/grafana/grafana-plugin-sdk-go/backend"
)

func TestHandleChatHistory(t *testing.T) {
	dir := t.TempDir()
	t.Setenv("GF_PATHS_DATA", dir)

	app := &App{}
	payload := chatHistoryPayload{
		Sessions:            []json.RawMessage{json.RawMessage(`{"id":"s1","title":"Hi","messages":[],"createdAt":1,"updatedAt":1}`)},
		LastActiveSessionID: "s1",
	}
	body, err := json.Marshal(payload)
	if err != nil {
		t.Fatal(err)
	}

	pluginCtx := backend.PluginContext{
		OrgID: 1,
		User:  &backend.User{Login: "tester"},
	}
	withCtx := func(req *http.Request) *http.Request {
		ctx := backend.WithPluginContext(req.Context(), pluginCtx)
		return req.WithContext(ctx)
	}

	putReq := withCtx(httptest.NewRequest(http.MethodPut, "/chat-history", bytes.NewReader(body)))
	putRec := httptest.NewRecorder()
	app.handleChatHistory(putRec, putReq)
	if putRec.Code != http.StatusOK {
		t.Fatalf("PUT status = %d, want 200", putRec.Code)
	}

	getReq := withCtx(httptest.NewRequest(http.MethodGet, "/chat-history", nil))
	getRec := httptest.NewRecorder()
	app.handleChatHistory(getRec, getReq)
	if getRec.Code != http.StatusOK {
		t.Fatalf("GET status = %d, want 200", getRec.Code)
	}

	var got chatHistoryPayload
	if err := json.NewDecoder(getRec.Body).Decode(&got); err != nil {
		t.Fatal(err)
	}
	if got.LastActiveSessionID != "s1" {
		t.Fatalf("lastActiveSessionId = %q, want s1", got.LastActiveSessionID)
	}
	if len(got.Sessions) != 1 {
		t.Fatalf("sessions len = %d, want 1", len(got.Sessions))
	}

	storagePath := filepath.Join(dir, "plugins-storage", "vikshana-graft-app", "chat-history", "1_tester.json")
	if _, err := os.Stat(storagePath); err != nil {
		t.Fatalf("expected storage file: %v", err)
	}
}
