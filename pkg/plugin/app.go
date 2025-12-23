package plugin

import (
	"context"
	"fmt"
	"net/http"

	"github.com/grafana/grafana-plugin-sdk-go/backend"
	"github.com/grafana/grafana-plugin-sdk-go/backend/instancemgmt"
	"github.com/grafana/grafana-plugin-sdk-go/backend/resource/httpadapter"
	"go.opentelemetry.io/otel/metric"
	"go.opentelemetry.io/otel/trace"
)

// Make sure App implements required interfaces.
var (
	_ backend.CallResourceHandler   = (*App)(nil)
	_ instancemgmt.InstanceDisposer = (*App)(nil)
	_ backend.CheckHealthHandler    = (*App)(nil)
)

// App is the Graft plugin instance.
// Model configuration has been moved to Grafana LLM plugin.
// This plugin only handles prompt library configuration.
type App struct {
	backend.CallResourceHandler
	tracer trace.Tracer
	// Metrics
	chatRequestsTotal    metric.Int64Counter
	chatRequestErrors    metric.Int64Counter
	chatDuration         metric.Float64Histogram
	llmTokensGenerated   metric.Int64Histogram
	llmFirstTokenLatency metric.Float64Histogram
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

	return &app, nil
}

func (a *App) registerRoutes(mux *http.ServeMux) {
	mux.HandleFunc("/settings", a.handleSettings)
	mux.HandleFunc("/ping", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		w.Write([]byte(`{"message": "ok"}`))
	})
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

// CheckHealth handles health checks sent from Grafana to the plugin.
// Model health is now checked via Grafana LLM plugin, not this plugin.
func (a *App) CheckHealth(ctx context.Context, _ *backend.CheckHealthRequest) (*backend.CheckHealthResult, error) {
	return &backend.CheckHealthResult{
		Status:  backend.HealthStatusOk,
		Message: "Plugin is running. Model configuration is managed by Grafana LLM plugin.",
	}, nil
}
