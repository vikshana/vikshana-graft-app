package main

import (
	"context"
	"os"
	"time"

	"github.com/grafana/grafana-plugin-sdk-go/backend/app"
	"github.com/grafana/grafana-plugin-sdk-go/backend/log"
	"github.com/vikshana/graft/pkg/plugin"
)

func main() {
	// Initialize OpenTelemetry BEFORE app.Manage
	ctx := context.Background()

	log.DefaultLogger.Info("Initializing OpenTelemetry SDK...")
	shutdown, tracerProvider, meterProvider, err := plugin.SetupOTelSDKWithoutGlobal(ctx)

	if err != nil {
		log.DefaultLogger.Error("Failed to initialize OTel SDK", "error", err)
		// Set nil providers so the fallback works
		plugin.SetGlobalProviders(nil, nil)
	} else {
		log.DefaultLogger.Info("✓ OpenTelemetry SDK initialized successfully")

		// CRITICAL: Set providers BEFORE app.Manage is called
		plugin.SetGlobalProviders(tracerProvider, meterProvider)
		log.DefaultLogger.Info("✓ OpenTelemetry providers stored",
			"tracerType", tracerProvider,
			"meterType", meterProvider)

		defer func() {
			shutdownCtx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
			defer cancel()

			if err := shutdown(shutdownCtx); err != nil {
				log.DefaultLogger.Error("Failed to shutdown OTel SDK", "error", err)
			} else {
				log.DefaultLogger.Info("OpenTelemetry SDK shutdown successfully")
			}
		}()
	}

	// At this point, providers should be set
	log.DefaultLogger.Info("Starting plugin server...")

	// Start listening to requests sent from Grafana. This call is blocking so
	// it won't finish until Grafana shuts down the process or the plugin choose
	// to exit by itself using os.Exit. Manage automatically manages life cycle
	// of app instances. It accepts app instance factory as first
	// argument. This factory will be automatically called on incoming request
	// from Grafana to create different instances of `App` (per plugin
	// ID).
	if err := app.Manage("vikshana-graft-app", plugin.NewApp, app.ManageOpts{}); err != nil {
		log.DefaultLogger.Error(err.Error())
		os.Exit(1)
	}
}
