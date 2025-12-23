import { WebTracerProvider } from '@opentelemetry/sdk-trace-web';
import { BatchSpanProcessor } from '@opentelemetry/sdk-trace-base';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { registerInstrumentations } from '@opentelemetry/instrumentation';
import { FetchInstrumentation } from '@opentelemetry/instrumentation-fetch';
import { DocumentLoadInstrumentation } from '@opentelemetry/instrumentation-document-load';
import { resourceFromAttributes } from '@opentelemetry/resources';
import { ATTR_SERVICE_NAME } from '@opentelemetry/semantic-conventions';

export const initOtel = () => {
    // Send traces to otel-lgtm OTLP HTTP endpoint
    // Note: This requires the browser to be able to reach localhost:4318
    const exporter = new OTLPTraceExporter({
        url: 'http://localhost:4318/v1/traces',
    });

    const provider = new WebTracerProvider({
        resource: resourceFromAttributes({
            [ATTR_SERVICE_NAME]: 'graft-plugin-frontend',
        }),
        spanProcessors: [new BatchSpanProcessor(exporter)],
    });
    provider.register();

    registerInstrumentations({
        instrumentations: [
            new DocumentLoadInstrumentation(),
            new FetchInstrumentation({
                propagateTraceHeaderCorsUrls: [
                    // Propagate trace context to the backend
                    // The backend is accessed via Grafana proxy, so we match the plugin route
                    /api\/plugins\/vikshana-graft-app/,
                ],
            }),
        ],
    });

    return provider;
};
