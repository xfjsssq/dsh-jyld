export const DEEPSEEK_BALANCE_URL = 'https://api.deepseek.com/user/balance';
function isObject(value) {
    return typeof value === 'object' && value !== null;
}
function asNumber(value) {
    if (typeof value === 'number')
        return Number.isFinite(value) ? value : null;
    if (typeof value !== 'string' || value.trim() === '')
        return null;
    const parsed = Number(value.trim());
    return Number.isFinite(parsed) ? parsed : null;
}
function asString(value) {
    return typeof value === 'string' ? value : '';
}
/**
 * Pick the balance entry to surface: prefer CNY (the account's native
 * currency), then any entry with a defined total_balance. Mirrors the whale
 * widget's `pickBalanceInfo`.
 */
export function pickDeepSeekBalanceInfo(infos) {
    if (!Array.isArray(infos))
        return undefined;
    const entries = infos.filter(isObject);
    if (entries.length === 0)
        return undefined;
    const withTotal = entries.filter(entry => asNumber(entry.total_balance) !== null);
    if (withTotal.length === 0)
        return undefined;
    return withTotal.find(entry => asString(entry.currency) === 'CNY') ?? withTotal[0];
}
/** Normalize the /user/balance payload. */
export function normalizeDeepSeekBalance(json) {
    const data = isObject(json) ? json : {};
    const info = pickDeepSeekBalanceInfo(data.balance_infos) ?? {};
    return {
        totalBalance: asNumber(info.total_balance),
        currency: asString(info.currency) || 'CNY',
        grantedBalance: asNumber(info.granted_balance),
        toppedUpBalance: asNumber(info.topped_up_balance),
    };
}
/**
 * Fetch the official balance with an API key. Throws on non-2xx; the caller
 * maps errors (e.g. AUTH for 401).
 */
export async function fetchDeepSeekBalance(apiKey, fetchImpl = fetch, url = DEEPSEEK_BALANCE_URL) {
    const response = await fetchImpl(url, {
        headers: { Authorization: `Bearer ${apiKey}` },
    });
    if (!response.ok) {
        const error = new Error(`DeepSeek balance upstream HTTP ${response.status}`);
        error.status = response.status;
        throw error;
    }
    const balance = normalizeDeepSeekBalance(await response.json().catch(() => null));
    if (balance.totalBalance === null) {
        throw new Error('DeepSeek balance response did not contain a numeric total_balance');
    }
    return balance;
}
