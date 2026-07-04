import React, { useEffect, useState } from 'react';
import { Alert, Spinner, Stack, Button } from '@grafana/ui';
import { getBackendSrv } from '@grafana/runtime';

import { getDrillDown } from '../../../services/sessionApi';

interface Props {
  handle: string;
  sessionId: string;
}

type PanelState = 'loading' | 'permission_denied' | 'error' | 'ready';

interface QueryResult {
  datasourceName?: string;
  queryType: string;
  expr: string;
  from: string;
  to: string;
  exploreUrl?: string;
  rawData?: unknown;
}

/**
 * EvidencePanel — re-executes a Grafana datasource query as the current viewer.
 *
 * Fetch flow (Option B):
 *   1. GET /api/sessions/drill-down/{handle}   → retrieve stored query params
 *   2. POST /api/ds/query                       → execute as current user
 *   3. Render result or permission-denied placeholder
 *
 * Because step 2 uses getBackendSrv() with the current user's credentials,
 * viewers who lack access to the datasource will see the placeholder rather
 * than the original agent data.  This is intentional — no credential sharing.
 */
export function EvidencePanel({ handle, sessionId }: Props) {
  const [state, setState] = useState<PanelState>('loading');
  const [result, setResult] = useState<QueryResult | null>(null);
  const [errorMsg, setErrorMsg] = useState<string>('');

  useEffect(() => {
    let cancelled = false;

    async function load() {
      setState('loading');
      try {
        // Step 1: retrieve stored query parameters
        const drillDown = await getDrillDown(handle);
        const fr = drillDown.full_result;
        const datasourceUid = fr.datasource_uid as string | undefined;
        const queryType = (fr.query_type as string) || 'metrics';
        const expr = (fr.expr as string) || '';
        const fromStr = (fr.from_ as string) || 'now-1h';
        const toStr = (fr.to as string) || 'now';

        if (!datasourceUid) {
          if (!cancelled) {
            setErrorMsg('No datasource UID in drill-down result');
            setState('error');
          }
          return;
        }

        // Step 2: re-execute as current viewer
        const body = {
          queries: [
            {
              refId: 'A',
              datasource: { uid: datasourceUid },
              expr,
              maxDataPoints: 200,
              queryType,
            },
          ],
          from: fromStr,
          to: toStr,
        };

        try {
          const resp = await getBackendSrv()
            .fetch<unknown>({
              url: '/api/ds/query',
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              data: body,
            })
            .toPromise();

          if (!cancelled) {
            // Build Explore deep-link
            const exploreParams = new URLSearchParams({
              orgId: '1',
              left: JSON.stringify({
                datasource: datasourceUid,
                queries: [{ refId: 'A', expr }],
                range: { from: fromStr, to: toStr },
              }),
            });

            setResult({
              queryType,
              expr,
              from: fromStr,
              to: toStr,
              exploreUrl: `/explore?${exploreParams.toString()}`,
              rawData: resp?.data,
            });
            setState('ready');
          }
        } catch (fetchErr: unknown) {
          // HTTP 403 → permission denied placeholder
          const status = (fetchErr as { status?: number })?.status;
          if (status === 403) {
            if (!cancelled) {
              setState('permission_denied');
            }
            return;
          }
          throw fetchErr;
        }
      } catch (e) {
        if (!cancelled) {
          setErrorMsg(String(e));
          setState('error');
        }
      }
    }

    load();
    return () => {
      cancelled = true;
    };
  }, [handle, sessionId]);

  if (state === 'loading') {
    return (
      <Stack alignItems="center" gap={1}>
        <Spinner />
        <span>Loading evidence…</span>
      </Stack>
    );
  }

  if (state === 'permission_denied') {
    return (
      <Alert
        data-testid="evidence-permission-denied"
        severity="warning"
        title="Access denied"
      >
        You don&apos;t have access to this datasource. The original investigation
        data is available to the session initiator.
      </Alert>
    );
  }

  if (state === 'error') {
    return (
      <Alert severity="error" title="Could not load evidence">
        {errorMsg}
      </Alert>
    );
  }

  return (
    <div data-testid="evidence-panel">
      <Stack direction="column" gap={1}>
        <Stack direction="row" justifyContent="space-between" alignItems="center">
          <span style={{ fontSize: 12, color: '#9fa7b3' }}>
            {result?.queryType}: <code>{result?.expr}</code> ({result?.from} → {result?.to})
          </span>
          {result?.exploreUrl && (
            <Button
              size="sm"
              variant="secondary"
              icon="compass"
              href={result.exploreUrl}
              target="_blank"
            >
              Open in Explore
            </Button>
          )}
        </Stack>
        <pre
          style={{
            fontSize: 11,
            background: 'rgba(0,0,0,0.2)',
            padding: 8,
            borderRadius: 4,
            maxHeight: 200,
            overflow: 'auto',
          }}
        >
          {JSON.stringify(result?.rawData, null, 2)}
        </pre>
      </Stack>
    </div>
  );
}
