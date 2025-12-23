export interface PreConfiguredPrompt {
    id: string;
    category: string;
    subCategory: string;
    content: string;
}

export const PRE_CONFIGURED_PROMPTS: Record<string, Record<string, string[]>> = {
    datasource_queries: {
        metrics_promql: [
            "Show me the rate of HTTP requests per second for the last 5 minutes",
            "Calculate the 95th percentile of request duration by handler",
            "List all pods that are currently in a CrashLoopBackOff state"
        ],
        logs_logql: [
            "Find all error logs for the 'auth-service' in the last hour",
            "Count the number of log lines per level for the 'payment-gateway' app",
            "Extract the 'latency' field from logs and calculate the average"
        ],
        traces_traceql: [
            "Find traces where the total duration is greater than 2 seconds",
            "Show traces that contain a span with error=true",
            "Find traces involving both 'frontend' and 'database' services"
        ]
    },
    dashboards: {
        create: [
            "Create a dashboard for monitoring Kubernetes cluster health",
            "Generate a dashboard for visualizing RED metrics (Rate, Errors, Duration)",
            "Build a dashboard to track business KPIs like active users and revenue"
        ],
        update: [
            "Add a variable to filter this dashboard by 'namespace'",
            "Change the visualization type of the 'Memory Usage' panel to a gauge",
            "Update the time range of all panels to default to 'Last 24 hours'"
        ],
        organize: [
            "Group related panels into a row called 'Database Metrics'",
            "Sort the panels by importance, putting critical metrics at the top",
            "Add a text panel with instructions on how to interpret these metrics"
        ]
    },
    alerts: {
        metric_promql: [
            "Alert when CPU usage exceeds 80% for more than 5 minutes",
            "Create an alert for high error rate (> 1%) on the ingress controller",
            "Notify when disk space is less than 10% free"
        ],
        logs_logql: [
            "Alert when more than 10 'Connection refused' errors occur in 1 minute",
            "Trigger an alert if a specific security exception is logged",
            "Alert on any log line containing 'PANIC' or 'FATAL'"
        ]
    }
};
