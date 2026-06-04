/**
 * User is asking why data is missing / how backfill relates to a panel — not asking Graft to edit the dashboard.
 */
export function isDashboardDataInvestigationQuestion(message: string): boolean {
    const text = message.trim();
    if (!text) {
        return false;
    }

    const asksWhy =
        /\b(why|what caused|how come|explain why|help me understand)\b/i.test(text) ||
        (/\?\s*$/.test(text) && /\b(why|no data|empty|missing)\b/i.test(text));

    const inspectOrDiagnose =
        /\b(inspect|investigate|diagnose|troubleshoot|figure out|understand why)\b/i.test(text);

    const timeRangeQuestion =
        /\bwhen I (?:select|zoom|pick)\b/i.test(text) &&
        /\b(time period|time range|period|range)\b/i.test(text);

    const backfillContext =
        /\bbackfill\b/i.test(text) &&
        (/\bscript\b/i.test(text) ||
            /\binflux\b/i.test(text) ||
            /\bml_predictions\b/i.test(text) ||
            /\bprometheus\b/i.test(text) ||
            /```/.test(text) ||
            text.length > 2000);

    const uidAndNoDataQuestion =
        /\buid[=:\s"]+[a-z0-9]+/i.test(text) &&
        asksWhy &&
        /\b(no data|shows? nothing|empty chart)\b/i.test(text);

    return asksWhy || inspectOrDiagnose || timeRangeQuestion || backfillContext || uidAndNoDataQuestion;
}
