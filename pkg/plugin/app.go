package plugin

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httputil"
	"net/url"
	"os"
	"strconv"
	"time"

	"github.com/grafana/grafana-plugin-sdk-go/backend"
	"github.com/grafana/grafana-plugin-sdk-go/backend/instancemgmt"
	"github.com/grafana/grafana-plugin-sdk-go/backend/resource/httpadapter"
	"go.opentelemetry.io/otel/metric"
	"go.opentelemetry.io/otel/trace"
)

// orgIDKey is the context key used to pass the Grafana org ID through the
// request lifecycle.  Using an unexported type avoids collisions with other
// context values.
type orgIDKey struct{}

// Make sure App implements required interfaces.
var (
	_ backend.CallResourceHandler   = (*App)(nil)
	_ instancemgmt.InstanceDisposer = (*App)(nil)
	_ backend.CheckHealthHandler    = (*App)(nil)
)

// App is the Graft plugin instance.
// Model configuration has been moved to Grafana LLM plugin.
// This plugin only handles prompt library configuration and RCA proxying.
type App struct {
	backend.CallResourceHandler
	tracer trace.Tracer
	// Chat metrics
	chatRequestsTotal    metric.Int64Counter
	chatRequestErrors    metric.Int64Counter
	chatDuration         metric.Float64Histogram
	llmTokensGenerated   metric.Int64Histogram
	llmFirstTokenLatency metric.Float64Histogram
	// RCA proxy metrics
	rcaRequestErrors metric.Int64Counter
}

// NewApp creates a new *App instance.
func NewApp(_ context.Context, settings backend.AppInstanceSettings) (instancemgmt.Instance, error) {
	var app App

	mux := http.NewServeMux()
	app.registerRoutes(mux)
	app.CallResourceHandler = httpadapter.New(mux)

	// Get TracerProvider from our custom global store
	tracerProvider := GetTracerProvider()
	backend.Logger.Info("Getting tracer from custom TracerProvider", "providerType", fmt.Sprintf("%T", tracerProvider))
	app.tracer = tracerProvider.Tracer("graft-plugin")

	// Initialize metrics using our custom global store
	meterProvider := GetMeterProvider()
	meter := meterProvider.Meter("graft-plugin")

	var err error
	app.chatRequestsTotal, err = meter.Int64Counter(
		"graft.chat.requests.total",
		metric.WithDescription("Total number of chat requests"),
		metric.WithUnit("{request}"),
	)
	if err != nil {
		return nil, err
	}

	app.chatRequestErrors, err = meter.Int64Counter(
		"graft.chat.requests.errors",
		metric.WithDescription("Total number of failed chat requests"),
		metric.WithUnit("{error}"),
	)
	if err != nil {
		return nil, err
	}

	app.chatDuration, err = meter.Float64Histogram(
		"graft.chat.duration",
		metric.WithDescription("Duration of chat requests in seconds"),
		metric.WithUnit("s"),
	)
	if err != nil {
		return nil, err
	}

	app.llmTokensGenerated, err = meter.Int64Histogram(
		"graft.llm.tokens.generated",
		metric.WithDescription("Number of tokens generated per response"),
		metric.WithUnit("{token}"),
	)
	if err != nil {
		return nil, err
	}

	app.llmFirstTokenLatency, err = meter.Float64Histogram(
		"graft.llm.first_token_latency",
		metric.WithDescription("Time to first token in seconds"),
		metric.WithUnit("s"),
	)
	if err != nil {
		return nil, err
	}

	app.rcaRequestErrors, err = meter.Int64Counter(
		"graft.rca.requests.errors",
		metric.WithDescription("Total number of failed RCA proxy requests"),
		metric.WithUnit("{error}"),
	)
	if err != nil {
		return nil, err
	}

	return &app, nil
}

// getEnv returns the value of an environment variable or a default.
func getEnv(key, defaultVal string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return defaultVal
}

func (a *App) registerRoutes(mux *http.ServeMux) {
	mux.HandleFunc("/settings", a.handleSettings)
	mux.HandleFunc("/tools", a.handleTools)
	mux.HandleFunc("/ping", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		w.Write([]byte(`{"message": "ok"}`))
	})

	// RCA reverse proxy — forwards /rca/* to the ORCA FastAPI backend.
	// FlushInterval: -1 is required for Server-Sent Events passthrough;
	// it disables response buffering so SSE chunks reach the client immediately.
	rcaBackendURL := getEnv("RCA_BACKEND_URL", "http://orca-backend:8000")
	rcaTarget, err := url.Parse(rcaBackendURL)
	if err != nil {
		backend.Logger.Error("Failed to parse RCA_BACKEND_URL", "url", rcaBackendURL, "err", err)
		return
	}

	rcaProxy := &httputil.ReverseProxy{
		FlushInterval: -1, // required for SSE passthrough
		Director: func(req *http.Request) {
			req.URL.Scheme = rcaTarget.Scheme
			req.URL.Host = rcaTarget.Host
			// Inject the Grafana org ID that was threaded through context by the SDK.
			// This comes from PluginContext.OrgID, which the client cannot spoof.
			if orgID, ok := req.Context().Value(orgIDKey{}).(int64); ok {
				req.Header.Set("X-Grafana-Org-Id", strconv.FormatInt(orgID, 10))
			}
		},
		ErrorHandler: func(w http.ResponseWriter, r *http.Request, err error) {
			backend.Logger.Error("RCA proxy error", "err", err)
			a.rcaRequestErrors.Add(r.Context(), 1)
			http.Error(w, "RCA backend unavailable", http.StatusBadGateway)
		},
	}

	mux.Handle("/rca/", http.StripPrefix("/rca", rcaProxy))
}

func (a *App) handleSettings(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
		return
	}

	pluginConfig := httpadapter.PluginConfigFromContext(r.Context())
	if pluginConfig.AppInstanceSettings == nil {
		http.Error(w, "Plugin config not found", http.StatusInternalServerError)
		return
	}

	w.Header().Set("Content-Type", "application/json")
	w.Write(pluginConfig.AppInstanceSettings.JSONData)
}

// Dispose tells plugin SDK that plugin wants to clean up resources.
func (a *App) Dispose() {
	// cleanup
}

// handleTools proxies a tools/list request to the grafana-llm-app MCP server
// and returns a simplified list of { name, description } objects.
// This allows the config page (which has no MCP React context) to fetch
// the live tool list for the Tool Access configuration UI.
func (a *App) handleTools(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
		return
	}

	// Derive the Grafana base URL from r.Host (the actual TCP host the plugin
	// backend is talking to), not from X-Forwarded-Host. X-Forwarded-Host is a
	// client-controlled header that can be spoofed; using it to build the target
	// URL would enable SSRF against arbitrary hosts.
	//
	// r.Host is set by the Grafana backend when it calls the plugin resource
	// endpoint and reliably reflects the real Grafana server address.
	//
	// We still read X-Forwarded-Proto for the scheme, but only to choose between
	// http and https — not to change the host.
	scheme := "http"
	if r.Header.Get("X-Forwarded-Proto") == "https" {
		scheme = "https"
	}
	host := r.Host
	if host == "" {
		host = "localhost:3000"
	}
	grafanaURL := fmt.Sprintf("%s://%s", scheme, host)

	mcpURL := fmt.Sprintf("%s/api/plugins/grafana-llm-app/resources/mcp/grafana", grafanaURL)

	// Standard MCP JSON-RPC tools/list request
	reqBody := []byte(`{"jsonrpc":"2.0","id":1,"method":"tools/list"}`)
	mcpReq, err := http.NewRequestWithContext(r.Context(), http.MethodPost, mcpURL, bytes.NewReader(reqBody))
	if err != nil {
		http.Error(w, "Failed to build MCP request", http.StatusInternalServerError)
		return
	}
	mcpReq.Header.Set("Content-Type", "application/json")

	// Forward the caller's auth cookie/token so Grafana accepts the request
	if authHeader := r.Header.Get("Authorization"); authHeader != "" {
		mcpReq.Header.Set("Authorization", authHeader)
	}
	for _, cookie := range r.Cookies() {
		mcpReq.AddCookie(cookie)
	}

	client := &http.Client{Timeout: 10 * time.Second}
	resp, err := client.Do(mcpReq)
	if err != nil {
		http.Error(w, "Failed to reach MCP server", http.StatusBadGateway)
		return
	}
	defer resp.Body.Close()

	body, err := io.ReadAll(resp.Body)
	if err != nil {
		http.Error(w, "Failed to read MCP response", http.StatusInternalServerError)
		return
	}

	if resp.StatusCode != http.StatusOK {
		http.Error(w, fmt.Sprintf("MCP server returned %d", resp.StatusCode), http.StatusBadGateway)
		return
	}

	// Parse the JSON-RPC response and extract just name + description per tool
	var rpcResp struct {
		Result struct {
			Tools []struct {
				Name        string `json:"name"`
				Description string `json:"description"`
			} `json:"tools"`
		} `json:"result"`
	}

	if err := json.Unmarshal(body, &rpcResp); err != nil {
		http.Error(w, "Failed to parse MCP response", http.StatusInternalServerError)
		return
	}

	type toolInfo struct {
		Name        string `json:"name"`
		Description string `json:"description"`
	}
	tools := make([]toolInfo, 0, len(rpcResp.Result.Tools))
	for _, t := range rpcResp.Result.Tools {
		tools = append(tools, toolInfo{Name: t.Name, Description: t.Description})
	}

	out, err := json.Marshal(map[string]interface{}{"tools": tools})
	if err != nil {
		http.Error(w, "Failed to serialise response", http.StatusInternalServerError)
		return
	}

	w.Header().Set("Content-Type", "application/json")
	w.Write(out)
}

// CallResource intercepts SDK call-resource requests to thread the Grafana org ID
// into the http.Request context before the mux routes it.  This ensures the RCA
// proxy Director can read the org ID (from PluginContext, not from the URL/body,
// so it cannot be spoofed by the browser client).
func (a *App) CallResource(ctx context.Context, req *backend.CallResourceRequest, sender backend.CallResourceResponseSender) error {
	ctx = context.WithValue(ctx, orgIDKey{}, req.PluginContext.OrgID)
	return a.CallResourceHandler.CallResource(ctx, req, sender)
}

// CheckHealth handles health checks sent from Grafana to the plugin.
// Model health is now checked via Grafana LLM plugin, not this plugin.
func (a *App) CheckHealth(ctx context.Context, _ *backend.CheckHealthRequest) (*backend.CheckHealthResult, error) {
	return &backend.CheckHealthResult{
		Status:  backend.HealthStatusOk,
		Message: "Plugin is running. Model configuration is managed by Grafana LLM plugin.",
	}, nil
}
