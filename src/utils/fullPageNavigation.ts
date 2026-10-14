/** Navigate by loading a new page, rather than changing the SPA route. */
export function navigateToFullPage(destination: string): void {
  window.location.href = destination;
}
