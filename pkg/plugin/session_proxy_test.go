package plugin

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strconv"
	"testing"
	"time"

	"github.com/grafana/grafana-plugin-sdk-go/backend"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// ---------------------------------------------------------------------------
// Session proxy RBAC tests
// ---------------------------------------------------------------------------

// TestSessionsRBACAllowedRole verifies that requests with an allowed Grafana
// role (Admin or Editor by default) are proxied through to the backend.
func TestSessionsRBACAllowedRole(t *testing.T) {
	for _, role := range []string{"Admin", "Editor"} {
		t.Run(role, func(t *testing.T) {
			var gotRequest bool
			be := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				gotRequest = true
				w.WriteHeader(http.StatusOK)
				w.Write([]byte(`{"sessions":[]}`))
			}))
			defer be.Close()

			t.Setenv("RCA_BACKEND_URL", be.URL)
			settings := backend.AppInstanceSettings{JSONData: []byte(`{}`)}
			appInstance, err := NewApp(context.Background(), settings)
			require.NoError(t, err)
			app := appInstance.(*App)

			mux := http.NewServeMux()
			app.registerRoutes(mux)
			app.registerSessionRoutes(mux, settings)

			req := httptest.NewRequest("GET", "/sessions/", nil)
			ctx := context.WithValue(req.Context(), orgRoleKey{}, role)
			req = req.WithContext(ctx)
			w := httptest.NewRecorder()
			mux.ServeHTTP(w, req)

			assert.Equal(t, http.StatusOK, w.Code,
				"role %q should be allowed through RBAC", role)
			assert.True(t, gotRequest, "backend should have received the request")
		})
	}
}

// TestSessionsRBACDeniedRole verifies that requests with a non-allowed role
// receive a 403 and the backend is never called.
func TestSessionsRBACDeniedRole(t *testing.T) {
	var backendCalled bool
	be := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		backendCalled = true
		w.WriteHeader(http.StatusOK)
	}))
	defer be.Close()

	t.Setenv("RCA_BACKEND_URL", be.URL)
	settings := backend.AppInstanceSettings{JSONData: []byte(`{}`)}
	appInstance, err := NewApp(context.Background(), settings)
	require.NoError(t, err)
	app := appInstance.(*App)

	mux := http.NewServeMux()
	app.registerRoutes(mux)
	app.registerSessionRoutes(mux, settings)

	req := httptest.NewRequest("GET", "/sessions/", nil)
	ctx := context.WithValue(req.Context(), orgRoleKey{}, "Viewer")
	req = req.WithContext(ctx)
	w := httptest.NewRecorder()
	mux.ServeHTTP(w, req)

	assert.Equal(t, http.StatusForbidden, w.Code, "Viewer should be forbidden")
	assert.Contains(t, w.Body.String(), "forbidden")
	assert.False(t, backendCalled, "backend should NOT have been called")
}

// TestSessionsRBACEmptyRole verifies that requests with no role set get a 403.
func TestSessionsRBACEmptyRole(t *testing.T) {
	be := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusOK)
	}))
	defer be.Close()

	t.Setenv("RCA_BACKEND_URL", be.URL)
	settings := backend.AppInstanceSettings{JSONData: []byte(`{}`)}
	appInstance, err := NewApp(context.Background(), settings)
	require.NoError(t, err)
	app := appInstance.(*App)

	mux := http.NewServeMux()
	app.registerRoutes(mux)
	app.registerSessionRoutes(mux, settings)

	// No orgRoleKey in context — simulates missing auth
	req := httptest.NewRequest("GET", "/sessions/", nil)
	w := httptest.NewRecorder()
	mux.ServeHTTP(w, req)

	assert.Equal(t, http.StatusForbidden, w.Code)
}

// TestSessionsCustomAllowedRoles verifies that plugin JSONData can override the
// default allowed roles list.
func TestSessionsCustomAllowedRoles(t *testing.T) {
	be := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusOK)
	}))
	defer be.Close()

	t.Setenv("RCA_BACKEND_URL", be.URL)
	// Override: only Viewer is allowed (unusual but tests the override path)
	settings := backend.AppInstanceSettings{
		JSONData: []byte(`{"agent_allowed_roles":["Viewer"]}`),
	}
	appInstance, err := NewApp(context.Background(), settings)
	require.NoError(t, err)
	app := appInstance.(*App)

	mux := http.NewServeMux()
	app.registerRoutes(mux)
	app.registerSessionRoutes(mux, settings)

	// Viewer should now be allowed
	req := httptest.NewRequest("GET", "/sessions/", nil)
	ctx := context.WithValue(req.Context(), orgRoleKey{}, "Viewer")
	req = req.WithContext(ctx)
	w := httptest.NewRecorder()
	mux.ServeHTTP(w, req)
	assert.Equal(t, http.StatusOK, w.Code, "Viewer should be allowed with custom config")

	// Admin should now be denied
	req2 := httptest.NewRequest("GET", "/sessions/", nil)
	ctx2 := context.WithValue(req2.Context(), orgRoleKey{}, "Admin")
	req2 = req2.WithContext(ctx2)
	w2 := httptest.NewRecorder()
	mux.ServeHTTP(w2, req2)
	assert.Equal(t, http.StatusForbidden, w2.Code, "Admin should be denied with custom config")
}

// ---------------------------------------------------------------------------
// HMAC signing tests
// ---------------------------------------------------------------------------

// TestSessionsHMACHeaderPresent verifies that when AGENT_INTERNAL_SECRET is
// set, the forwarded request carries X-Agent-Signature and X-Agent-Timestamp.
func TestSessionsHMACHeaderPresent(t *testing.T) {
	var gotSig, gotTS string
	be := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotSig = r.Header.Get("X-Agent-Signature")
		gotTS = r.Header.Get("X-Agent-Timestamp")
		w.WriteHeader(http.StatusOK)
	}))
	defer be.Close()

	t.Setenv("RCA_BACKEND_URL", be.URL)
	t.Setenv("AGENT_INTERNAL_SECRET", "test-secret-phase2")

	settings := backend.AppInstanceSettings{JSONData: []byte(`{}`)}
	appInstance, err := NewApp(context.Background(), settings)
	require.NoError(t, err)
	app := appInstance.(*App)

	mux := http.NewServeMux()
	app.registerRoutes(mux)
	app.registerSessionRoutes(mux, settings)

	req := httptest.NewRequest("GET", "/sessions/", nil)
	ctx := context.WithValue(req.Context(), orgRoleKey{}, "Admin")
	req = req.WithContext(ctx)
	w := httptest.NewRecorder()
	mux.ServeHTTP(w, req)

	assert.NotEmpty(t, gotSig, "X-Agent-Signature should be set")
	assert.NotEmpty(t, gotTS, "X-Agent-Timestamp should be set")
	// Timestamp should be a recent unix epoch
	ts, err := parseTimestamp(gotTS)
	require.NoError(t, err)
	assert.WithinDuration(t, time.Now(), time.Unix(ts, 0), 5*time.Second)
}

// TestSessionsHMACHeaderAbsent verifies that without AGENT_INTERNAL_SECRET the
// forwarded request does NOT carry an X-Agent-Signature header.
func TestSessionsHMACHeaderAbsent(t *testing.T) {
	var gotSig string
	be := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotSig = r.Header.Get("X-Agent-Signature")
		w.WriteHeader(http.StatusOK)
	}))
	defer be.Close()

	t.Setenv("RCA_BACKEND_URL", be.URL)
	t.Setenv("AGENT_INTERNAL_SECRET", "") // explicitly empty

	settings := backend.AppInstanceSettings{JSONData: []byte(`{}`)}
	appInstance, err := NewApp(context.Background(), settings)
	require.NoError(t, err)
	app := appInstance.(*App)

	mux := http.NewServeMux()
	app.registerRoutes(mux)
	app.registerSessionRoutes(mux, settings)

	req := httptest.NewRequest("GET", "/sessions/", nil)
	ctx := context.WithValue(req.Context(), orgRoleKey{}, "Admin")
	req = req.WithContext(ctx)
	w := httptest.NewRecorder()
	mux.ServeHTTP(w, req)

	assert.Empty(t, gotSig, "X-Agent-Signature should be absent when no secret is configured")
}

// ---------------------------------------------------------------------------
// Sessions proxy behaviour tests
// ---------------------------------------------------------------------------

// TestSessionsOrgIDInjected verifies that X-Grafana-Org-Id is injected from
// context on /sessions/ requests (same guarantee as on /rca/).
func TestSessionsOrgIDInjected(t *testing.T) {
	var receivedOrgID string
	be := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		receivedOrgID = r.Header.Get("X-Grafana-Org-Id")
		w.WriteHeader(http.StatusOK)
	}))
	defer be.Close()

	t.Setenv("RCA_BACKEND_URL", be.URL)
	settings := backend.AppInstanceSettings{JSONData: []byte(`{}`)}
	appInstance, err := NewApp(context.Background(), settings)
	require.NoError(t, err)
	app := appInstance.(*App)

	mux := http.NewServeMux()
	app.registerRoutes(mux)
	app.registerSessionRoutes(mux, settings)

	req := httptest.NewRequest("GET", "/sessions/", nil)
	ctx := context.WithValue(req.Context(), orgIDKey{}, int64(7))
	ctx = context.WithValue(ctx, orgRoleKey{}, "Admin")
	req = req.WithContext(ctx)
	w := httptest.NewRecorder()
	mux.ServeHTTP(w, req)

	assert.Equal(t, "7", receivedOrgID, "X-Grafana-Org-Id should be injected from context")
}

// TestSessionsSSEPassthrough verifies that SSE event streams pass through the
// /sessions/ proxy without buffering.
func TestSessionsSSEPassthrough(t *testing.T) {
	be := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/event-stream")
		w.Header().Set("Cache-Control", "no-cache")
		if f, ok := w.(http.Flusher); ok {
			f.Flush()
		}
		w.Write([]byte("data: {\"type\":\"step\"}\n\n"))
		if f, ok := w.(http.Flusher); ok {
			f.Flush()
		}
		w.Write([]byte("data: {\"type\":\"done\"}\n\n"))
	}))
	defer be.Close()

	t.Setenv("RCA_BACKEND_URL", be.URL)
	settings := backend.AppInstanceSettings{JSONData: []byte(`{}`)}
	appInstance, err := NewApp(context.Background(), settings)
	require.NoError(t, err)
	app := appInstance.(*App)

	mux := http.NewServeMux()
	app.registerRoutes(mux)
	app.registerSessionRoutes(mux, settings)

	req := httptest.NewRequest("GET", "/sessions/stream/test-id", nil)
	ctx := context.WithValue(req.Context(), orgRoleKey{}, "Editor")
	req = req.WithContext(ctx)
	w := httptest.NewRecorder()
	mux.ServeHTTP(w, req)

	body := w.Body.String()
	assert.Contains(t, body, "data:", "SSE events should pass through session proxy")
}

// TestSessions502OnBackendUnavailable verifies the session proxy returns 502
// when the backend is unreachable.
func TestSessions502OnBackendUnavailable(t *testing.T) {
	t.Setenv("RCA_BACKEND_URL", "http://127.0.0.1:19998") // guaranteed dead port

	settings := backend.AppInstanceSettings{JSONData: []byte(`{}`)}
	appInstance, err := NewApp(context.Background(), settings)
	require.NoError(t, err)
	app := appInstance.(*App)

	mux := http.NewServeMux()
	app.registerRoutes(mux)
	app.registerSessionRoutes(mux, settings)

	req := httptest.NewRequest("GET", "/sessions/", nil)
	ctx, cancel := context.WithTimeout(req.Context(), 2*time.Second)
	defer cancel()
	ctx = context.WithValue(ctx, orgRoleKey{}, "Admin")
	req = req.WithContext(ctx)
	w := httptest.NewRecorder()
	mux.ServeHTTP(w, req)

	assert.Equal(t, http.StatusBadGateway, w.Code)
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

func parseTimestamp(s string) (int64, error) {
	var ts int64
	_, err := parseIntFromString(s, &ts)
	return ts, err
}

func parseIntFromString(s string, out *int64) (int, error) {
	n, err := strconv.ParseInt(s, 10, 64)
	if err != nil {
		return 0, err
	}
	*out = n
	return len(s), nil
}
