// TokenRhythm balance: pure parsing + an injectable fetch.
//
// Field semantics from the live tokenrhythm.studio web API (usage-summary +
// me), as established by the community dsh-tokenrhythm-bill plugin: balance is
// only readable with the web session cookie (`tr_session=…`); the API key
// returns 401. See NOTICE.md and the billing doc in README.
/** Web session rejected by the platform. */
export class SessionExpiredError extends Error {
    name = 'SessionExpiredError';
    code = 'SESSION_EXPIRED';
}
const TOKENRHYTHM_BASE = 'https://tokenrhythm.studio';
/** Authentication header the balance API requires (the web session cookie). */
const TR_SESSION_COOKIE = 'tr_session';
function isObject(value) {
    return typeof value === 'object' && value !== null;
}
/** Strip the common {data: …} envelope when present. */
export function unwrapEnvelope(json) {
    if (!isObject(json))
        return {};
    if (isObject(json.data))
        return json.data;
    return json;
}
function asString(value) {
    return typeof value === 'string' ? value : '';
}
/** Parse finite numeric values, including JSON APIs that encode amounts as strings. */
function asNumber(value) {
    if (typeof value === 'number')
        return Number.isFinite(value) ? value : null;
    if (typeof value !== 'string' || value.trim() === '')
        return null;
    const parsed = Number(value.trim());
    return Number.isFinite(parsed) ? parsed : null;
}
/** First numeric value among candidate keys, or null when none is finite. */
function pickNum(source, keys) {
    for (const key of keys) {
        const value = asNumber(source[key]);
        if (value !== null)
            return value;
    }
    return null;
}
/** Account display name: name > nickname > username > email > id. */
export function accountNameFromMe(meJson) {
    const me = unwrapEnvelope(meJson);
    for (const key of ['name', 'nickname', 'username', 'email', 'id']) {
        const value = asString(me[key]);
        if (value !== '')
            return value;
    }
    return '';
}
/**
 * Normalize usage-summary + me into a clean balance record, tolerating
 * {data:…} envelopes and snake_case variants.
 */
export function normalizeBalance(summaryJson, meJson) {
    const summary = unwrapEnvelope(summaryJson);
    return {
        balanceCny: pickNum(summary, ['balanceCny', 'balance', 'balance_cny', 'availableBalanceCny', 'available_balance_cny']),
        availableBalanceCny: pickNum(summary, ['availableBalanceCny', 'available_balance_cny']),
        frozenBalanceCny: pickNum(summary, ['frozenBalanceCny', 'frozen_balance_cny']),
        expiringBalanceCny: pickNum(summary, ['expiringBalanceCny', 'expiring_balance_cny']),
        nextExpiryAt: asString(summary.nextExpiryAt ?? summary.next_expiry_at) || null,
        currency: asString(summary.currency) || 'CNY',
        account: accountNameFromMe(meJson),
        fetchedAt: Date.now(),
    };
}
/**
 * Build the auth headers for a balance request. The official SPA authenticates
 * with `Authorization: Bearer <token>`; some responses also require the
 * `tr_session` cookie. Send both when present so either accepted path works.
 */
function sessionHeaders(credentials) {
    const headers = {};
    if (credentials.token !== undefined && credentials.token !== '') {
        headers.Authorization = `Bearer ${credentials.token}`;
    }
    if (credentials.cookie !== undefined && credentials.cookie !== '') {
        headers.Cookie = `${TR_SESSION_COOKIE}=${credentials.cookie}`;
    }
    return headers;
}
/**
 * Fetch the current balance with the web-session bearer token (and optional
 * `tr_session` cookie). Throws SessionExpiredError when the platform rejects
 * the session (401).
 */
export async function fetchBalance(credentials, fetchImpl = fetch, baseUrl = TOKENRHYTHM_BASE) {
    const headers = sessionHeaders(credentials);
    const [summaryResponse, meResponse] = await Promise.all([
        fetchImpl(`${baseUrl}/api/usage-summary`, { headers }),
        fetchImpl(`${baseUrl}/api/me`, { headers }).catch(() => null),
    ]);
    if (summaryResponse.status === 401 || (meResponse !== null && meResponse.status === 401)) {
        throw new SessionExpiredError('TokenRhythm web session expired or rejected');
    }
    if (!summaryResponse.ok) {
        throw new Error(`TokenRhythm usage-summary upstream HTTP ${summaryResponse.status}`);
    }
    const summary = await summaryResponse.json().catch(() => null);
    const me = meResponse !== null && meResponse.ok ? await meResponse.json().catch(() => null) : null;
    return normalizeBalance(summary, me);
}
/** Never send the full session secret toward the browser; show only a masked hint. */
export function maskCookie(cookie) {
    if (cookie.length === 0)
        return '';
    if (cookie.length <= 6)
        return `${cookie.slice(0, 1)}…(${cookie.length})`;
    return `${cookie.slice(0, 4)}…(${cookie.length})`;
}
/**
 * Accept only a plausible `tr_session` value: URL-safe token characters,
 * bounded length. Rejects junk before it reaches the state file.
 */
export function normalizeSessionCookie(input) {
    const trimmed = input.trim();
    const match = /(?:^|;\s*)tr_session=([^;\s]+)/.exec(trimmed);
    return match?.[1] ?? trimmed;
}
export function isValidSessionCookie(cookie) {
    return /^[A-Za-z0-9_-]{8,512}$/.test(normalizeSessionCookie(cookie));
}
/** Render a CNY balance for display. */
export function formatCny(value) {
    if (value === null)
        return '—';
    return `¥${value.toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}
