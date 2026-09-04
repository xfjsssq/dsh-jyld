import { SessionExpiredError, fetchBalance, isValidSessionCookie, maskCookie, normalizeSessionCookie } from "./balance.js";
import { sessionStatus } from "./store.js";
import { fetchDeepSeekBalance } from "./deepseek.js";
import { isValidLoginForm, loginTokenRhythm } from "./login.js";
/** The real login transport: adapt the global fetch, exposing Set-Cookie values. */
const realLoginFetch = async (url, init) => {
    const response = await fetch(url, {
        ...(init.method === undefined ? {} : { method: init.method }),
        ...(init.headers === undefined ? {} : { headers: init.headers }),
        ...(init.body === undefined ? {} : { body: init.body }),
    });
    const setCookie = typeof response.headers.getSetCookie === 'function'
        ? response.headers.getSetCookie()
        : (response.headers.get('set-cookie') ?? '').split(/,(?=[^;]+=)/);
    return {
        ok: response.ok,
        status: response.status,
        json: () => response.json(),
        setCookie,
    };
};
function writeJson(res, status, value) {
    res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify(value));
}
async function readJsonBody(req) {
    let text = '';
    for await (const chunk of req)
        text += chunk;
    if (text === '')
        return {};
    try {
        const parsed = JSON.parse(text);
        return typeof parsed === 'object' && parsed !== null ? parsed : {};
    }
    catch {
        return {};
    }
}
/** Handle one request under the /dsh-opensquilla prefix. */
export async function handleBillingRequest(deps, req, res) {
    try {
        const url = new URL(req.url ?? '/', 'http://localhost');
        const pathname = url.pathname;
        const method = req.method ?? 'GET';
        if (pathname === '/dsh-opensquilla/billing/balance' && method === 'GET') {
            // Source 1: TokenRhythm web-session balance (bearer token + optional cookie).
            const cookie = deps.store.read();
            const token = deps.store.readToken();
            let tokenrhythm;
            if (cookie === '' && token === '') {
                tokenrhythm = { status: 'no-session', message: '未配置 TokenRhythm 网页会话' };
            }
            else {
                try {
                    const balance = await (deps.fetchImpl === undefined
                        ? fetchBalance({ token, cookie })
                        : fetchBalance({ token, cookie }, deps.fetchImpl, deps.baseUrl ?? 'https://tokenrhythm.studio'));
                    tokenrhythm = { status: 'ok', balance };
                }
                catch (error) {
                    if (error instanceof SessionExpiredError) {
                        tokenrhythm = { status: 'session-expired', message: '网页会话已过期，请重新登录' };
                    }
                    else {
                        // Upstream hiccup (5xx/timeout): transient, auto-retried by the
                        // panel poll — report it as such instead of a raw HTTP error.
                        tokenrhythm = { status: 'unavailable', message: 'TokenRhythm 服务暂时不可用，正在自动重试' };
                    }
                }
            }
            // Source 2: DeepSeek official balance via the API key.
            let deepseek;
            try {
                const apiKey = deps.resolveDeepSeekKey === undefined ? undefined : await deps.resolveDeepSeekKey();
                if (apiKey === undefined || apiKey === '') {
                    deepseek = { status: 'no-key', message: '未配置 DEEPSEEK_API_KEY' };
                }
                else {
                    const balance = deps.deepseekFetchImpl === undefined
                        ? await fetchDeepSeekBalance(apiKey)
                        : await fetchDeepSeekBalance(apiKey, deps.deepseekFetchImpl);
                    deepseek = { status: 'ok', balance };
                }
            }
            catch (error) {
                deepseek = { status: 'error', message: String(error?.message ?? error) };
            }
            writeJson(res, 200, { ok: true, sources: { tokenrhythm, deepseek } });
            return;
        }
        if (pathname === '/dsh-opensquilla/billing/login' && method === 'POST') {
            const body = await readJsonBody(req);
            const account = typeof body.account === 'string' ? body.account : '';
            const password = typeof body.password === 'string' ? body.password : '';
            if (!isValidLoginForm(account, password)) {
                writeJson(res, 400, { ok: false, code: 'INVALID_FORM', message: '账号或密码不合法' });
                return;
            }
            // The login is PINNED to the official origin; the balance baseURL
            // (test seam / mirror) never sees credentials.
            const result = deps.loginFetchImpl === undefined
                ? await loginTokenRhythm(account, password, realLoginFetch)
                : await loginTokenRhythm(account, password, deps.loginFetchImpl);
            // The platform now issues session credentials ONLY via Set-Cookie
            // (verified live 2026-09-03: login returns {code:0,data:{user}} with no
            // token field; the tr_session cookie alone authorizes
            // /api/usage-summary). Accept a cookie-only login instead of demanding
            // a body token.
            const hasToken = result.ok && result.token !== undefined && result.token !== '';
            const hasCookie = result.ok && result.cookie !== undefined && result.cookie !== '';
            if (!result.ok || (!hasToken && !hasCookie)) {
                writeJson(res, 200, { ok: false, code: result.code ?? 'LOGIN_FAILED', message: result.error });
                return;
            }
            if (hasToken) {
                const token = result.token;
                deps.store.writeSession(token, {
                    ...(result.cookie === undefined ? {} : { cookie: result.cookie }),
                    ...(result.csrf === undefined ? {} : { csrf: result.csrf }),
                });
                writeJson(res, 200, { ok: true, masked: maskCookie(token) });
            }
            else {
                const cookie = result.cookie;
                deps.store.write(cookie);
                writeJson(res, 200, { ok: true, masked: maskCookie(cookie) });
            }
            return;
        }
        if (pathname === '/dsh-opensquilla/billing/logout' && method === 'POST') {
            deps.store.clear();
            writeJson(res, 200, { ok: true });
            return;
        }
        if (pathname === '/dsh-opensquilla/billing/session') {
            if (method === 'GET') {
                writeJson(res, 200, { ok: true, ...sessionStatus(deps.store) });
                return;
            }
            if (method === 'POST') {
                const body = await readJsonBody(req);
                const cookie = typeof body.cookie === 'string' ? normalizeSessionCookie(body.cookie) : '';
                if (!isValidSessionCookie(cookie)) {
                    writeJson(res, 400, { ok: false, code: 'INVALID_COOKIE', message: '会话 Cookie 格式不合法' });
                    return;
                }
                deps.store.write(cookie);
                writeJson(res, 200, { ok: true, masked: maskCookie(cookie) });
                return;
            }
            if (method === 'DELETE') {
                deps.store.clear();
                writeJson(res, 200, { ok: true });
                return;
            }
        }
        writeJson(res, 404, { ok: false, code: 'NOT_FOUND', message: 'not found' });
    }
    catch (error) {
        try {
            writeJson(res, 500, { ok: false, code: 'INTERNAL', message: String(error?.message ?? error) });
        }
        catch {
            // Socket already closed.
        }
    }
}
/** Register the billing routes on a web host, returning the disposer. */
export function registerBillingRoutes(webServer, deps) {
    return webServer.register({
        kind: 'prefix',
        path: '/dsh-opensquilla',
        handler: (req, res) => handleBillingRequest(deps, req, res),
    });
}
