// TokenRhythm web-session login: exchange account credentials for the bearer
// session token the balance API requires, WITHOUT ever storing the password.
//
// Live-platform contract (verified 2026-09-02 against the official SPA): the
// login endpoint is POST {base}/api/auth/login with JSON {account, password}
// (skipAuth), and the success envelope is `{ code, message, data: { user, token } }`.
// All subsequent authenticated calls attach `Authorization: Bearer <token>`;
// a `tr_session` cookie may also be issued. The password exists only in memory
// for the single request. The login endpoint is PINNED to the official origin
// — a misconfigured baseURL can never steer credentials elsewhere.
// See NOTICE.md.
export const TOKENRHYTHM_AUTH_BASE = 'https://tokenrhythm.studio';
export const TR_SESSION_RE = /tr_session=([^;\s]+)/;
export const TR_CSRF_RE = /tr_csrf=([^;\s]+)/;
function extractCookie(values, re) {
    for (const line of values ?? []) {
        // One header can contain multiple Set-Cookie values in older fetch
        // implementations. Scan each occurrence rather than assuming one line.
        const match = re.exec(line);
        if (match !== null)
            return match[1];
    }
    return '';
}
function cookieFromBody(value, name) {
    if (!isRecord(value))
        return '';
    for (const key of [name, `${name}Cookie`, `${name}_cookie`]) {
        const candidate = value[key];
        if (typeof candidate === 'string' && candidate.length > 0) {
            if (candidate.includes('=')) {
                const match = new RegExp(`${name}=([^;\\s]+)`).exec(candidate);
                if (match !== null)
                    return match[1];
            }
            return candidate;
        }
    }
    for (const nested of Object.values(value)) {
        const found = cookieFromBody(nested, name);
        if (found !== '')
            return found;
    }
    return '';
}
function isRecord(value) {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}
function readString(record, key) {
    const value = record[key];
    return typeof value === 'string' && value.length > 0 ? value : undefined;
}
const TOKEN_KEYS = ['token', 'accessToken', 'access_token', 'sessionToken', 'session_token', 'id_token', 'jwt'];
/**
 * Extract a bearer token from the login envelope. The platform has moved the
 * credential field across releases (`data.token`, `data.accessToken`, and
 * deeper nests), so walk the response tree for any plausible session-token
 * key rather than pinning one shape. Shallow, bounded, and prefers the real
 * bearer token over a generic `session` id.
 */
function tokenFromLoginResponse(json) {
    if (!isRecord(json))
        return undefined;
    // Prefer the explicitly nested `data.*` first (the historical shape).
    if (isRecord(json.data)) {
        for (const key of TOKEN_KEYS) {
            const hit = readString(json.data, key);
            if (hit !== undefined)
                return hit;
        }
    }
    // Then any depth-limited match anywhere in the tree.
    return findTokenValue(json, TOKEN_KEYS, 4);
}
/** Depth-limited recursive search for a string under any of the given keys. */
function findTokenValue(node, keys, depth) {
    if (depth <= 0 || !isRecord(node))
        return undefined;
    for (const [key, value] of Object.entries(node)) {
        if (keys.includes(key) && typeof value === 'string' && value.length > 0)
            return value;
    }
    for (const value of Object.values(node)) {
        const found = findTokenValue(value, keys, depth - 1);
        if (found !== undefined)
            return found;
    }
    return undefined;
}
/** Validate a login form before it reaches the wire. */
export function isValidLoginForm(account, password) {
    return account.length > 0
        && account.length <= 256
        && password.length > 0
        && password.length <= 512;
}
/**
 * Log in on the official TokenRhythm origin and capture the bearer session
 * token (plus any issued cookie/CSRF). Never returns the password.
 */
export async function loginTokenRhythm(account, password, fetchImpl, base = TOKENRHYTHM_AUTH_BASE) {
    let response;
    try {
        response = await fetchImpl(`${base}/api/auth/login`, {
            method: 'POST',
            headers: { 'content-type': 'application/json', Accept: 'application/json' },
            body: JSON.stringify({ account, password }),
        });
    }
    catch (error) {
        return { ok: false, error: `登录请求失败: ${String(error?.message ?? error)}`, code: 'UPSTREAM' };
    }
    // Read the body before branching so we can surface the platform's real
    // detail (risk control, captcha, etc.) instead of guessing from the code.
    let body = null;
    try {
        body = await response.json();
    }
    catch {
        // Non-JSON error body — status alone still identifies the failure.
    }
    if (!response.ok) {
        const code = response.status === 401 ? 'BAD_CREDENTIALS' : 'UPSTREAM';
        const message = isRecord(body)
            ? readString(body, 'message') ?? readString(body, 'error') ?? readString(body, 'code')
            : undefined;
        const label = response.status === 401
            ? (message === undefined ? '账号或密码错误' : `账号或密码错误（${message}）`)
            : `登录失败(平台 ${response.status})${message === undefined ? '' : `: ${message}`}`;
        return { ok: false, error: label, code };
    }
    const sessionToken = tokenFromLoginResponse(body);
    const cookie = extractCookie(response.setCookie, TR_SESSION_RE) || cookieFromBody(body, 'tr_session');
    const csrf = extractCookie(response.setCookie, TR_CSRF_RE) || cookieFromBody(body, 'tr_csrf');
    // The platform issues a cookie session on some flows. Treat a `tr_session`
    // cookie as a valid credential when the envelope carried no bearer token, so
    // a successful login still yields a working session (the balance request
    // sends both Bearer and Cookie). Fail only when we have neither.
    if ((sessionToken === undefined || sessionToken === '') && cookie === '') {
        return { ok: false, error: '登录成功但未返回会话凭证，请改用粘贴方式', code: 'NO_SESSION' };
    }
    return {
        ok: true,
        ...(sessionToken === undefined || sessionToken === '' ? {} : { token: sessionToken }),
        ...(cookie === '' ? {} : { cookie }),
        ...(csrf === '' ? {} : { csrf }),
    };
}
