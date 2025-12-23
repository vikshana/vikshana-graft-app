package plugin

import (
	"context"
	"fmt"
	"os"
	"sync"
	"time"

	"github.com/grafana/grafana-plugin-sdk-go/backend/log"

	"go.opentelemetry.io/otel"
	"go.opentelemetry.io/otel/exporters/otlp/otlpmetric/otlpmetricgrpc"
	"go.opentelemetry.io/otel/exporters/otlp/otlptrace/otlptracegrpc"
	"go.opentelemetry.io/otel/metric"
	"go.opentelemetry.io/otel/propagation"
	sdkmetric "go.opentelemetry.io/otel/sdk/metric"
	"go.opentelemetry.io/otel/sdk/resource"
	sdktrace "go.opentelemetry.io/otel/sdk/trace"
	semconv "go.opentelemetry.io/otel/semconv/v1.17.0"
	"go.opentelemetry.io/otel/trace"
)

var (
	globalTracerProvider trace.TracerProvider
	globalMeterProvider  metric.MeterProvider
	providerMutex        sync.RWMutex
)

// SetGlobalProviders stores the OTel providers for plugin use
func SetGlobalProviders(tp trace.TracerProvider, mp metric.MeterProvider) {
	providerMutex.Lock()
	defer providerMutex.Unlock()
	globalTracerProvider = tp
	globalMeterProvider = mp
}

// GetTracerProvider returns the custom tracer provider or falls back to otel global
func GetTracerProvider() trace.TracerProvider {
	providerMutex.RLock()
	defer providerMutex.RUnlock()

	log.DefaultLogger.Debug("GetTracerProvider called",
		"hasCustomProvider", globalTracerProvider != nil,
		"customProviderType", fmt.Sprintf("%T", globalTracerProvider))

	if globalTracerProvider != nil {
		return globalTracerProvider
	}

	fallback := otel.GetTracerProvider()
	log.DefaultLogger.Warn("Using fallback tracer provider",
		"fallbackType", fmt.Sprintf("%T", fallback))
	return fallback
}

// GetMeterProvider returns the custom meter provider or falls back to otel global
func GetMeterProvider() metric.MeterProvider {
	providerMutex.RLock()
	defer providerMutex.RUnlock()
	if globalMeterProvider != nil {
		return globalMeterProvider
	}
	return otel.GetMeterProvider()
}

// SetupOTelSDKWithoutGlobal bootstraps the OpenTelemetry pipeline WITHOUT setting global providers.
// This prevents conflicts with app.Manage's automatic tracer configuration.
// Returns: shutdown function, TracerProvider, MeterProvider, error
func SetupOTelSDKWithoutGlobal(ctx context.Context) (func(context.Context) error, trace.TracerProvider, metric.MeterProvider, error) {
	// Get endpoint from environment variable or use default
	endpoint := os.Getenv("OTEL_EXPORTER_OTLP_ENDPOINT")
	if endpoint == "" {
		endpoint = "otel-lgtm:4317"
	}

	log.DefaultLogger.Info("Initializing OTel exporter", "endpoint", endpoint)

	exporter, err := otlptracegrpc.New(ctx,
		otlptracegrpc.WithEndpoint(endpoint),
		otlptracegrpc.WithInsecure())
	if err != nil {
		return nil, nil, nil, fmt.Errorf("failed to create trace exporter: %w", err)
	}

	// Identify the service
	res, err := resource.New(ctx,
		resource.WithAttributes(
			semconv.ServiceName("graft-plugin-backend"),
		),
	)
	if err != nil {
		return nil, nil, nil, fmt.Errorf("failed to create resource: %w", err)
	}

	// Create the TracerProvider with AlwaysOn sampler
	tp := sdktrace.NewTracerProvider(
		sdktrace.WithBatcher(exporter),
		sdktrace.WithResource(res),
		sdktrace.WithSampler(sdktrace.AlwaysSample()),
	)

	log.DefaultLogger.Info("OpenTelemetry TracerProvider created", "providerType", fmt.Sprintf("%T", tp))

	// Create metrics exporter
	metricsExporter, err := otlpmetricgrpc.New(ctx,
		otlpmetricgrpc.WithEndpoint(endpoint),
		otlpmetricgrpc.WithInsecure(),
	)
	if err != nil {
		return nil, nil, nil, fmt.Errorf("failed to create metrics exporter: %w", err)
	}

	// Create MeterProvider with periodic reader
	mp := sdkmetric.NewMeterProvider(
		sdkmetric.WithResource(res),
		sdkmetric.WithReader(
			sdkmetric.NewPeriodicReader(
				metricsExporter,
				sdkmetric.WithInterval(10*time.Second), // Export every 10 seconds
			),
		),
	)

	// Return combined shutdown function and providers
	shutdown := func(ctx context.Context) error {
		if err := tp.Shutdown(ctx); err != nil {
			return fmt.Errorf("tracer provider shutdown error: %w", err)
		}
		if err := mp.Shutdown(ctx); err != nil {
			return fmt.Errorf("meter provider shutdown error: %w", err)
		}
		return nil
	}

	return shutdown, tp, mp, nil
}

// SetupOTelSDK bootstraps the OpenTelemetry pipeline and sets global providers.
// If it does not return an error, make sure to call shutdown for proper cleanup.
// NOTE: This may conflict with app.Manage's automatic tracer configuration.
func SetupOTelSDK(ctx context.Context) (func(context.Context) error, error) {
	shutdown, tp, mp, err := SetupOTelSDKWithoutGlobal(ctx)
	if err != nil {
		return nil, err
	}

	// Set the global TracerProvider
	otel.SetTracerProvider(tp)
	log.DefaultLogger.Info("OpenTelemetry TracerProvider set globally", "providerType", fmt.Sprintf("%T", tp))

	// Set the global Propagator to W3C Trace Context (standard for OTel)
	otel.SetTextMapPropagator(propagation.TraceContext{})

	// Set the global MeterProvider
	otel.SetMeterProvider(mp)

	return shutdown, nil
}
