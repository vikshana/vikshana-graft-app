package plugin

import (
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"net/http"
	"net/http/httputil"
	"net/url"
	"strconv"
	"strings"
	"time"

	"github.com/grafana/grafana-plugin-sdk-go/backend"
)

// orgRoleKey is the context key used to pass the Grafana org role through the
// request lifecycle.  Using an unexported type avoids collisions with other
// context values.
type orgRoleKey struct{}

// sessionRBACConfig is the subset of plugin JSON settings that control which
// Grafana roles may access the agent session API.
type sessionRBACConfig struct {
	AllowedRoles []string `json:"agent_allowed_roles"`
}

// defaultAllowedRoles is the fallback when agent_allowed_roles is not configured.
var defaultAllowedRoles = []string{"Admin", "Editor"}

// registerSessionRoutes registers the /sessions/ reverse proxy with RBAC and
// HMAC signing.  It is called from registerRoutes in app.go so all session
// endpoints share the same mux as the existing /rca/ proxy.
//
// The /sessions/ path is forwarded to the same ORCA FastAPI backend with:
//   - X-Grafana-Org-Id injected from PluginContext (as on /rca/)
//   - Plugin-level RBAC: only allowed Grafana roles may reach the backend
//   - X-Agent-Signature HMAC header when AGENT_INTERNAL_SECRET is set
func (a *App) registerSessionRoutes(mux *http.ServeMux, settings backend.AppInstanceSettings) {
	rcaBackendURL := getEnv("RCA_BACKEND_URL", "http://orca-backend:8000")
	target, err := url.Parse(rcaBackendURL)
	if err != nil {
		backend.Logger.Error("Failed to parse RCA_BACKEND_URL for session proxy",
			"url", rcaBackendURL, "err", err)
		return
	}

	// Parse allowed roles from plugin settings, fall back to defaults.
	allowed := parseAllowedRoles(settings)
	secret := getEnv("AGENT_INTERNAL_SECRET", "")

	sessionProxy := &httputil.ReverseProxy{
		FlushInterval: -1, // required for SSE passthrough
		Director: func(req *http.Request) {
			req.URL.Scheme = target.Scheme
			req.URL.Host = target.Host

			// Inject Grafana org ID (from PluginContext, not spoofable)
			if orgID, ok := req.Context().Value(orgIDKey{}).(int64); ok {
				req.Header.Set("X-Grafana-Org-Id", strconv.FormatInt(orgID, 10))
			}

			// Add HMAC signature when the internal secret is configured.
			// The signature covers the timestamp + request path so it is
			// replay-resistant and path-scoped.
			if secret != "" {
				ts := strconv.FormatInt(time.Now().Unix(), 10)
				mac := hmac.New(sha256.New, []byte(secret))
				mac.Write([]byte(ts + ":" + req.URL.Path))
				req.Header.Set("X-Agent-Signature", hex.EncodeToString(mac.Sum(nil)))
				req.Header.Set("X-Agent-Timestamp", ts)
			}
		},
		ErrorHandler: func(w http.ResponseWriter, r *http.Request, err error) {
			backend.Logger.Error("Session proxy error", "err", err)
			a.rcaRequestErrors.Add(r.Context(), 1)
			http.Error(w, "Agent backend unavailable", http.StatusBadGateway)
		},
	}

	// Wrap with RBAC middleware before registering on the mux.
	mux.Handle("/sessions/",
		rbacMiddleware(allowed,
			http.StripPrefix("/sessions", sessionProxy),
		),
	)
}

// rbacMiddleware returns an http.Handler that enforces Grafana role-based access
// control.  Requests whose role is not in allowedRoles receive a 403 JSON error.
// Requests without a role in context (e.g. unauthenticated) are also rejected.
//
// The role is read from the orgRoleKey context value, which is set by
// CallResource from PluginContext.User.OrgRole.
func rbacMiddleware(allowedRoles []string, next http.Handler) http.Handler {
	allowed := make(map[string]bool, len(allowedRoles))
	for _, r := range allowedRoles {
		allowed[strings.TrimSpace(r)] = true
	}

	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		role, _ := r.Context().Value(orgRoleKey{}).(string)
		if role == "" || !allowed[role] {
			w.Header().Set("Content-Type", "application/json")
			w.WriteHeader(http.StatusForbidden)
			w.Write([]byte(`{"error":"forbidden","detail":"your Grafana role is not permitted to use the agent"}`))
			return
		}
		next.ServeHTTP(w, r)
	})
}

// parseAllowedRoles reads agent_allowed_roles from the plugin AppInstanceSettings
// JSON data.  Falls back to defaultAllowedRoles if the setting is absent or
// unparseable.
func parseAllowedRoles(settings backend.AppInstanceSettings) []string {
	if settings.JSONData == nil {
		return defaultAllowedRoles
	}
	var cfg sessionRBACConfig
	if err := json.Unmarshal(settings.JSONData, &cfg); err != nil || len(cfg.AllowedRoles) == 0 {
		return defaultAllowedRoles
	}
	return cfg.AllowedRoles
}
