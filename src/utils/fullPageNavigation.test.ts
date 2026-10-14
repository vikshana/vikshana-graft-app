/** @jest-environment node */
import { navigateToFullPage } from './fullPageNavigation';

test('full-page navigation assigns the exact destination to window.location.href', () => {
  const originalWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
  const location = { href: 'https://grafana.example/existing-page' };
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: { location },
  });

  try {
    navigateToFullPage('/plugins/vikshana-graft-app?page=configuration');

    expect(location.href).toBe('/plugins/vikshana-graft-app?page=configuration');
  } finally {
    if (originalWindow) {
      Object.defineProperty(globalThis, 'window', originalWindow);
    } else {
      Reflect.deleteProperty(globalThis, 'window');
    }
  }
});
