function writeJson(res, status, value) {
    res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify(value));
}
/** Handle one request under the /dsh-opensquilla-routing prefix. */
export async function handleRoutingRequest(deps, req, res) {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const pathname = url.pathname;
    const method = req.method ?? 'GET';
    if (pathname === '/dsh-opensquilla-routing/pool' && method === 'GET') {
        const options = deps.options();
        writeJson(res, 200, {
            ok: true,
            routingEnabled: deps.routingEnabled(),
            provider: options.provider,
            routingModelId: options.routingModelId,
            providers: options.routingProviders,
            classifierMode: options.classifierMode,
            routingNotice: options.routingNotice,
            promptHint: options.promptHint,
            antiDowngradeEnabled: options.policy.antiDowngradeEnabled ?? false,
            defaultTier: options.policy.defaultTier ?? 'c0',
            tiers: options.tiers,
            validTiers: options.validTiers,
        });
        return;
    }
    if (pathname === '/dsh-opensquilla-routing/trace' && method === 'GET') {
        const sessionId = url.searchParams.get('sessionId') ?? undefined;
        writeJson(res, 200, { ok: true, entries: deps.trace(sessionId) });
        return;
    }
    writeJson(res, 404, { ok: false, code: 'NOT_FOUND', message: `no routing route for ${method} ${pathname}` });
}
export function registerRoutingRoutes(webServer, deps) {
    return webServer.register({
        kind: 'prefix',
        path: '/dsh-opensquilla-routing',
        handler: (req, res) => handleRoutingRequest(deps, req, res),
    });
}
