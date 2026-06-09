import fs from 'node:fs';
import path from 'node:path';

import { test as setup } from '@playwright/test';

const AUTH_FILE = process.env.GRAFANA_STORAGE_STATE || 'playwright/.auth/admin.json';
const GRAFANA_USER = process.env.GRAFANA_ADMIN_USER || 'admin';
const GRAFANA_PASSWORD = process.env.GRAFANA_ADMIN_PASSWORD || 'admin';
const BASE_URL = process.env.GRAFANA_URL || 'http://localhost:3000';

function isRemoteGrafana(): boolean {
    try {
        const { hostname } = new URL(BASE_URL);
        return hostname !== 'localhost' && hostname !== '127.0.0.1';
    } catch {
        return false;
    }
}

function authHelpMessage(apiError: string): string {
    return [
        `Could not authenticate to Grafana at ${BASE_URL} as user "${GRAFANA_USER}".`,
        apiError ? `API /login response: ${apiError}` : '',
        '',
        'You do not log in manually during the test run unless you use the one-time capture step below.',
        '',
        'Option A — one-time browser login (recommended for EC2):',
        '  npm run test:regression:e2e:login',
        '  Log in in the browser window that opens, then close it.',
        '  GRAFANA_E2E=1 GRAFANA_REUSE_AUTH=1 npm run test:regression:e2e',
        '',
        'Option B — pass the same username/password you use in Grafana:',
        '  GRAFANA_URL=https://35.175.68.13',
        '  GRAFANA_ADMIN_USER=<your-grafana-username>',
        '  GRAFANA_ADMIN_PASSWORD=<your-grafana-password>',
        '  GRAFANA_E2E=1 npm run test:regression:e2e',
        '',
        'Note: EC2 does not accept the default admin/admin credentials.',
    ]
        .filter(Boolean)
        .join('\n');
}

async function storageStateIsValid(browser: import('@playwright/test').Browser): Promise<boolean> {
    if (!fs.existsSync(AUTH_FILE)) {
        return false;
    }

    const context = await browser.newContext({
        storageState: AUTH_FILE,
        ignoreHTTPSErrors: true,
        baseURL: BASE_URL,
    });
    const page = await context.newPage();

    try {
        const response = await page.goto('/api/user', { waitUntil: 'domcontentloaded' });
        return response?.ok() === true;
    } catch {
        return false;
    } finally {
        await context.close();
    }
}

setup('authenticate Graft regression E2E', async ({ browser, request, page }) => {
    fs.mkdirSync(path.dirname(AUTH_FILE), { recursive: true });

    if (process.env.GRAFANA_REUSE_AUTH === '1' && (await storageStateIsValid(browser))) {
        return;
    }

    if (isRemoteGrafana() && GRAFANA_USER === 'admin' && GRAFANA_PASSWORD === 'admin') {
        throw new Error(authHelpMessage('Default admin/admin was rejected.'));
    }

    const loginRes = await request.post('/login', {
        data: { user: GRAFANA_USER, password: GRAFANA_PASSWORD },
    });

    if (loginRes.ok()) {
        await request.storageState({ path: AUTH_FILE });
        return;
    }

    const apiError = (await loginRes.text()).trim();

    await page.goto('/login');
    const userInput = page.locator('input[name="user"]').first();
    const passwordInput = page.locator('input[name="password"]').first();
    const loginButton = page.locator('button[type="submit"]').first();

    await userInput.fill(GRAFANA_USER);
    await passwordInput.fill(GRAFANA_PASSWORD);
    await loginButton.click();

    try {
        await page.waitForURL((url) => !url.pathname.endsWith('/login'), { timeout: 20_000 });
    } catch {
        throw new Error(authHelpMessage(apiError));
    }

    await page.context().storageState({ path: AUTH_FILE });
});
