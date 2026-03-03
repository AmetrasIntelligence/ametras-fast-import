var __awaiter = (this && this.__awaiter) || function (thisArg, _arguments, P, generator) {
    function adopt(value) { return value instanceof P ? value : new P(function (resolve) { resolve(value); }); }
    return new (P || (P = Promise))(function (resolve, reject) {
        function fulfilled(value) { try { step(generator.next(value)); } catch (e) { reject(e); } }
        function rejected(value) { try { step(generator["throw"](value)); } catch (e) { reject(e); } }
        function step(result) { result.done ? resolve(result.value) : adopt(result.value).then(fulfilled, rejected); }
        step((generator = generator.apply(thisArg, _arguments || [])).next());
    });
};
var __generator = (this && this.__generator) || function (thisArg, body) {
    var _ = { label: 0, sent: function() { if (t[0] & 1) throw t[1]; return t[1]; }, trys: [], ops: [] }, f, y, t, g = Object.create((typeof Iterator === "function" ? Iterator : Object).prototype);
    return g.next = verb(0), g["throw"] = verb(1), g["return"] = verb(2), typeof Symbol === "function" && (g[Symbol.iterator] = function() { return this; }), g;
    function verb(n) { return function (v) { return step([n, v]); }; }
    function step(op) {
        if (f) throw new TypeError("Generator is already executing.");
        while (g && (g = 0, op[0] && (_ = 0)), _) try {
            if (f = 1, y && (t = op[0] & 2 ? y["return"] : op[0] ? y["throw"] || ((t = y["return"]) && t.call(y), 0) : y.next) && !(t = t.call(y, op[1])).done) return t;
            if (y = 0, t) op = [op[0] & 2, t.value];
            switch (op[0]) {
                case 0: case 1: t = op; break;
                case 4: _.label++; return { value: op[1], done: false };
                case 5: _.label++; y = op[1]; op = [0]; continue;
                case 7: op = _.ops.pop(); _.trys.pop(); continue;
                default:
                    if (!(t = _.trys, t = t.length > 0 && t[t.length - 1]) && (op[0] === 6 || op[0] === 2)) { _ = 0; continue; }
                    if (op[0] === 3 && (!t || (op[1] > t[0] && op[1] < t[3]))) { _.label = op[1]; break; }
                    if (op[0] === 6 && _.label < t[1]) { _.label = t[1]; t = op; break; }
                    if (t && _.label < t[2]) { _.label = t[2]; _.ops.push(op); break; }
                    if (t[2]) _.ops.pop();
                    _.trys.pop(); continue;
            }
            op = body.call(thisArg, _);
        } catch (e) { op = [6, e]; y = 0; } finally { f = t = 0; }
        if (op[0] & 5) throw op[1]; return { value: op[0] ? op[1] : void 0, done: true };
    }
};
import { ipcMain } from 'electron';
// Session TTL: 30 minutes of inactivity
var SESSION_TTL_MS = 30 * 60 * 1000;
// Maximum session age: 8 hours
var SESSION_MAX_AGE_MS = 8 * 60 * 60 * 1000;
// Cleanup interval: 5 minutes
var CLEANUP_INTERVAL_MS = 5 * 60 * 1000;
// Request timeouts for Odoo RPC calls
var RPC_TIMEOUT_MS = 30000; // 30s for general RPC calls
var AUTH_TIMEOUT_MS = 15000; // 15s for authentication
var DB_LIST_TIMEOUT_MS = 10000; // 10s for database listing
var sessions = new Map();
/**
 * Clean up expired sessions.
 * Removes sessions that:
 * - Have been inactive for longer than SESSION_TTL_MS
 * - Are older than SESSION_MAX_AGE_MS
 */
function cleanupExpiredSessions() {
    var now = Date.now();
    var expiredKeys = [];
    for (var _i = 0, sessions_1 = sessions; _i < sessions_1.length; _i++) {
        var _a = sessions_1[_i], key = _a[0], session = _a[1];
        var inactiveTime = now - session.lastActivity;
        var sessionAge = now - session.createdAt;
        if (inactiveTime > SESSION_TTL_MS || sessionAge > SESSION_MAX_AGE_MS) {
            expiredKeys.push(key);
        }
    }
    for (var _b = 0, expiredKeys_1 = expiredKeys; _b < expiredKeys_1.length; _b++) {
        var key = expiredKeys_1[_b];
        sessions.delete(key);
    }
    if (expiredKeys.length > 0) {
        console.log("[session] Cleaned up ".concat(expiredKeys.length, " expired session(s)"));
    }
}
/**
 * Update session activity timestamp.
 */
function touchSession(session) {
    session.lastActivity = Date.now();
}
/**
 * Check if session is still valid (not expired).
 */
function isSessionValid(session) {
    var now = Date.now();
    var inactiveTime = now - session.lastActivity;
    var sessionAge = now - session.createdAt;
    return inactiveTime <= SESSION_TTL_MS && sessionAge <= SESSION_MAX_AGE_MS;
}
// Start periodic cleanup
var cleanupInterval = null;
function startSessionCleanup() {
    if (cleanupInterval)
        return;
    cleanupInterval = setInterval(cleanupExpiredSessions, CLEANUP_INTERVAL_MS);
    // Don't prevent app from exiting
    cleanupInterval.unref();
}
function stopSessionCleanup() {
    if (cleanupInterval) {
        clearInterval(cleanupInterval);
        cleanupInterval = null;
    }
}
// Start cleanup on module load
startSessionCleanup();
/**
 * Validate URL is a proper HTTP(S) URL to prevent SSRF and injection attacks.
 */
function validateBaseUrl(baseUrl) {
    try {
        var url = new URL(baseUrl);
        // Only allow HTTP(S) protocols
        if (url.protocol !== 'http:' && url.protocol !== 'https:') {
            return { valid: false, error: 'Only HTTP and HTTPS protocols are allowed' };
        }
        // Prevent localhost/internal network access in production (optional - remove if needed for dev)
        // const isLocal = url.hostname === 'localhost' || url.hostname === '127.0.0.1' || url.hostname.startsWith('192.168.')
        // if (isLocal && process.env.NODE_ENV === 'production') {
        //   return { valid: false, error: 'Local network access not allowed' }
        // }
        return { valid: true };
    }
    catch (_a) {
        return { valid: false, error: 'Invalid URL format' };
    }
}
/**
 * Validate endpoint is a relative path, not an absolute URL.
 */
function validateEndpoint(endpoint) {
    // Endpoint must start with / and not contain protocol
    if (!endpoint.startsWith('/')) {
        return { valid: false, error: 'Endpoint must start with /' };
    }
    if (endpoint.includes('://')) {
        return { valid: false, error: 'Endpoint must be a relative path' };
    }
    return { valid: true };
}
function getSessionKey(baseUrl, db) {
    return "".concat(baseUrl, "::").concat(db);
}
// Fetch available databases from Odoo server
ipcMain.handle('odoo:listDatabases', function (_event, baseUrl) { return __awaiter(void 0, void 0, void 0, function () {
    var urlCheck, response, data, e_1, message;
    return __generator(this, function (_a) {
        switch (_a.label) {
            case 0:
                urlCheck = validateBaseUrl(baseUrl);
                if (!urlCheck.valid) {
                    return [2 /*return*/, { ok: false, databases: [], error: urlCheck.error }];
                }
                _a.label = 1;
            case 1:
                _a.trys.push([1, 4, , 5]);
                return [4 /*yield*/, fetch("".concat(baseUrl, "/web/database/list"), {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({
                            jsonrpc: '2.0',
                            method: 'call',
                            params: {},
                            id: Date.now()
                        }),
                        signal: AbortSignal.timeout(DB_LIST_TIMEOUT_MS)
                    })];
            case 2:
                response = _a.sent();
                return [4 /*yield*/, response.json()];
            case 3:
                data = _a.sent();
                if (data.error) {
                    // Database list might be disabled for security
                    return [2 /*return*/, { ok: false, databases: [], error: 'Database listing disabled' }];
                }
                return [2 /*return*/, { ok: true, databases: data.result || [] }];
            case 4:
                e_1 = _a.sent();
                message = e_1 instanceof Error ? e_1.message : 'Failed to fetch databases';
                return [2 /*return*/, { ok: false, databases: [], error: message }];
            case 5: return [2 /*return*/];
        }
    });
}); });
ipcMain.handle('odoo:authenticate', function (_event, params) { return __awaiter(void 0, void 0, void 0, function () {
    var urlCheck, baseUrl, db, login, password, response, data, result, cookies, sessionMatch, sessionId, now, session, e_2, message;
    var _a;
    return __generator(this, function (_b) {
        switch (_b.label) {
            case 0:
                urlCheck = validateBaseUrl(params.baseUrl);
                if (!urlCheck.valid) {
                    return [2 /*return*/, { ok: false, error: urlCheck.error }];
                }
                _b.label = 1;
            case 1:
                _b.trys.push([1, 4, , 5]);
                baseUrl = params.baseUrl, db = params.db, login = params.login, password = params.password;
                return [4 /*yield*/, fetch("".concat(baseUrl, "/web/session/authenticate"), {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({
                            jsonrpc: '2.0',
                            method: 'call',
                            params: { db: db, login: login, password: password },
                            id: Date.now()
                        }),
                        signal: AbortSignal.timeout(AUTH_TIMEOUT_MS)
                    })];
            case 2:
                response = _b.sent();
                return [4 /*yield*/, response.json()];
            case 3:
                data = _b.sent();
                if (data.error) {
                    return [2 /*return*/, { ok: false, error: ((_a = data.error.data) === null || _a === void 0 ? void 0 : _a.message) || 'Authentication failed' }];
                }
                result = data.result;
                if (!result.uid) {
                    return [2 /*return*/, { ok: false, error: 'Invalid credentials' }];
                }
                cookies = response.headers.get('set-cookie');
                sessionMatch = cookies === null || cookies === void 0 ? void 0 : cookies.match(/session_id=([^;]+)/);
                sessionId = (sessionMatch === null || sessionMatch === void 0 ? void 0 : sessionMatch[1]) || '';
                now = Date.now();
                session = {
                    baseUrl: baseUrl,
                    db: db,
                    uid: result.uid,
                    sessionId: sessionId,
                    serverVersion: result.server_version,
                    lastActivity: now,
                    createdAt: now
                };
                sessions.set(getSessionKey(baseUrl, db), session);
                return [2 /*return*/, {
                        ok: true,
                        uid: result.uid,
                        session_id: sessionId,
                        server_version: result.server_version
                    }];
            case 4:
                e_2 = _b.sent();
                message = e_2 instanceof Error ? e_2.message : 'Connection failed';
                return [2 /*return*/, { ok: false, error: message }];
            case 5: return [2 /*return*/];
        }
    });
}); });
ipcMain.handle('odoo:call', function (_event, payload) { return __awaiter(void 0, void 0, void 0, function () {
    var urlCheck, endpointCheck, baseUrl_1, endpoint, params, session, candidates, key, response, status_1, data, e_3, errorCode, msg, message;
    var _a;
    return __generator(this, function (_b) {
        switch (_b.label) {
            case 0:
                urlCheck = validateBaseUrl(payload.baseUrl);
                if (!urlCheck.valid) {
                    return [2 /*return*/, { ok: false, error: urlCheck.error }];
                }
                endpointCheck = validateEndpoint(payload.endpoint);
                if (!endpointCheck.valid) {
                    return [2 /*return*/, { ok: false, error: endpointCheck.error }];
                }
                _b.label = 1;
            case 1:
                _b.trys.push([1, 4, , 5]);
                baseUrl_1 = payload.baseUrl, endpoint = payload.endpoint, params = payload.params;
                session = payload.db
                    ? sessions.get(getSessionKey(baseUrl_1, payload.db))
                    : undefined;
                if (!session) {
                    candidates = Array.from(sessions.values()).filter(function (s) { return s.baseUrl === baseUrl_1; });
                    if (candidates.length > 1) {
                        console.warn("[odoo:call] Ambiguous session fallback: ".concat(candidates.length, " sessions for ").concat(baseUrl_1, " ") +
                            "(dbs: ".concat(candidates.map(function (s) { return s.db; }).join(', '), "). Pass 'db' parameter to avoid wrong-database auth."));
                    }
                    session = candidates[0];
                }
                if (!session) {
                    return [2 /*return*/, { ok: false, error: 'Not authenticated' }];
                }
                // Check if session is expired
                if (!isSessionValid(session)) {
                    key = getSessionKey(session.baseUrl, session.db);
                    sessions.delete(key);
                    return [2 /*return*/, { ok: false, error: 'Session expired - please login again' }];
                }
                // Update activity timestamp
                touchSession(session);
                return [4 /*yield*/, fetch("".concat(baseUrl_1).concat(endpoint), {
                        method: 'POST',
                        headers: {
                            'Content-Type': 'application/json',
                            'Cookie': "session_id=".concat(session.sessionId)
                        },
                        body: JSON.stringify({
                            jsonrpc: '2.0',
                            method: 'call',
                            params: params,
                            id: Date.now()
                        }),
                        signal: AbortSignal.timeout(RPC_TIMEOUT_MS)
                    })
                    // Check HTTP-level errors before parsing JSON
                ];
            case 2:
                response = _b.sent();
                // Check HTTP-level errors before parsing JSON
                if (!response.ok) {
                    status_1 = response.status;
                    if (status_1 === 502 || status_1 === 503 || status_1 === 504) {
                        return [2 /*return*/, { ok: false, error: "HTTP ".concat(status_1, ": Server unavailable"), errorCode: 'NETWORK_ERROR' }];
                    }
                    return [2 /*return*/, { ok: false, error: "HTTP ".concat(status_1, ": ").concat(response.statusText), errorCode: 'UNKNOWN' }];
                }
                return [4 /*yield*/, response.json()];
            case 3:
                data = _b.sent();
                if (data.error) {
                    return [2 /*return*/, {
                            ok: false,
                            error: ((_a = data.error.data) === null || _a === void 0 ? void 0 : _a.message) || data.error.message || 'RPC Error',
                            errorCode: 'DATA_ERROR'
                        }];
                }
                return [2 /*return*/, { ok: true, result: data.result }];
            case 4:
                e_3 = _b.sent();
                errorCode = 'UNKNOWN';
                if (e_3 instanceof TypeError) {
                    // TypeError from fetch = DNS failure, connection refused, offline
                    errorCode = 'NETWORK_ERROR';
                }
                else if (e_3 instanceof DOMException && e_3.name === 'AbortError') {
                    errorCode = 'TIMEOUT';
                }
                else if (e_3 instanceof Error) {
                    msg = e_3.message.toLowerCase();
                    if (msg.includes('timeout') || msg.includes('timed out') || msg.includes('aborted')) {
                        errorCode = 'TIMEOUT';
                    }
                    else if (msg.includes('network') || msg.includes('failed to fetch') || msg.includes('net::')) {
                        errorCode = 'NETWORK_ERROR';
                    }
                }
                message = e_3 instanceof Error ? e_3.message : 'Request failed';
                return [2 /*return*/, { ok: false, error: message, errorCode: errorCode }];
            case 5: return [2 /*return*/];
        }
    });
}); });
export function getSession(baseUrl, db) {
    var session;
    if (db) {
        session = sessions.get(getSessionKey(baseUrl, db));
    }
    else {
        // Fallback: find any session for this baseUrl, warn if ambiguous
        var candidates = Array.from(sessions.values()).filter(function (s) { return s.baseUrl === baseUrl; });
        if (candidates.length > 1) {
            console.warn("[session] Ambiguous session lookup: ".concat(candidates.length, " sessions for ").concat(baseUrl, " ") +
                "(dbs: ".concat(candidates.map(function (s) { return s.db; }).join(', '), "). Pass 'db' to avoid wrong-database auth."));
        }
        session = candidates[0];
    }
    // Return only if session is still valid
    if (session && isSessionValid(session)) {
        touchSession(session);
        return session;
    }
    // Remove expired session
    if (session) {
        sessions.delete(getSessionKey(session.baseUrl, session.db));
    }
    return undefined;
}
export function clearSessions() {
    sessions.clear();
}
/**
 * Cleanup on app quit - clear all sessions and stop interval.
 */
export function shutdownSessions() {
    stopSessionCleanup();
    sessions.clear();
}
