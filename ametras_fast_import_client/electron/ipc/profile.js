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
import { ipcMain, dialog } from 'electron';
import fs from 'fs/promises';
import path from 'path';
import { getSession } from './odoo';
/**
 * Validate URL is a proper HTTP(S) URL to prevent SSRF and injection attacks.
 */
function validateBaseUrl(baseUrl) {
    try {
        var url = new URL(baseUrl);
        if (url.protocol !== 'http:' && url.protocol !== 'https:') {
            return { valid: false, error: 'Only HTTP and HTTPS protocols are allowed' };
        }
        return { valid: true };
    }
    catch (_a) {
        return { valid: false, error: 'Invalid URL format' };
    }
}
/**
 * Validate file path to prevent path traversal attacks.
 */
function validateFilePath(filePath) {
    // Check for path traversal patterns
    if (filePath.includes('..') || filePath.includes('\0')) {
        return { valid: false, error: 'Invalid file path' };
    }
    // Ensure it's an absolute path
    if (!path.isAbsolute(filePath)) {
        return { valid: false, error: 'File path must be absolute' };
    }
    return { valid: true };
}
// Select a ZIP file via dialog
ipcMain.handle('profile:selectZip', function () { return __awaiter(void 0, void 0, void 0, function () {
    var _a, canceled, filePaths, filePath;
    return __generator(this, function (_b) {
        switch (_b.label) {
            case 0: return [4 /*yield*/, dialog.showOpenDialog({
                    properties: ['openFile'],
                    filters: [
                        { name: 'ZIP Files', extensions: ['zip'] }
                    ]
                })];
            case 1:
                _a = _b.sent(), canceled = _a.canceled, filePaths = _a.filePaths;
                if (canceled || filePaths.length === 0)
                    return [2 /*return*/, null];
                filePath = filePaths[0];
                return [2 /*return*/, {
                        path: filePath,
                        name: path.basename(filePath)
                    }];
        }
    });
}); });
// Upload a ZIP file to Odoo via multipart POST
ipcMain.handle('profile:upload', function (_event, payload) { return __awaiter(void 0, void 0, void 0, function () {
    var urlCheck, pathCheck, baseUrl, filePath, session, fileBuffer, fileName, boundary, header, footer, headerBuf, footerBuf, body, response, data, e_1, message;
    return __generator(this, function (_a) {
        switch (_a.label) {
            case 0:
                urlCheck = validateBaseUrl(payload.baseUrl);
                if (!urlCheck.valid) {
                    return [2 /*return*/, { ok: false, error: urlCheck.error }];
                }
                pathCheck = validateFilePath(payload.filePath);
                if (!pathCheck.valid) {
                    return [2 /*return*/, { ok: false, error: pathCheck.error }];
                }
                _a.label = 1;
            case 1:
                _a.trys.push([1, 5, , 6]);
                baseUrl = payload.baseUrl, filePath = payload.filePath;
                session = getSession(baseUrl, payload.db);
                if (!session) {
                    return [2 /*return*/, { ok: false, error: 'Not authenticated' }];
                }
                return [4 /*yield*/, fs.readFile(filePath)];
            case 2:
                fileBuffer = _a.sent();
                fileName = path.basename(filePath);
                boundary = '----FormBoundary' + Date.now().toString(36);
                header = "--".concat(boundary, "\r\nContent-Disposition: form-data; name=\"file\"; filename=\"").concat(fileName, "\"\r\nContent-Type: application/zip\r\n\r\n");
                footer = "\r\n--".concat(boundary, "--\r\n");
                headerBuf = Buffer.from(header, 'utf-8');
                footerBuf = Buffer.from(footer, 'utf-8');
                body = Buffer.concat([headerBuf, fileBuffer, footerBuf]);
                return [4 /*yield*/, fetch("".concat(baseUrl, "/ametras_fast_import/profile/upload"), {
                        method: 'POST',
                        headers: {
                            'Content-Type': "multipart/form-data; boundary=".concat(boundary),
                            'Cookie': "session_id=".concat(session.sessionId)
                        },
                        body: body
                    })];
            case 3:
                response = _a.sent();
                return [4 /*yield*/, response.json()];
            case 4:
                data = _a.sent();
                if (!data.ok) {
                    return [2 /*return*/, { ok: false, error: data.error || 'Upload failed' }];
                }
                return [2 /*return*/, { ok: true, result: data.result }];
            case 5:
                e_1 = _a.sent();
                message = e_1 instanceof Error ? e_1.message : 'Upload failed';
                return [2 /*return*/, { ok: false, error: message }];
            case 6: return [2 /*return*/];
        }
    });
}); });
// Download/export a profile ZIP from Odoo
ipcMain.handle('profile:export', function (_event, payload) { return __awaiter(void 0, void 0, void 0, function () {
    var urlCheck, baseUrl, profileId, profileName, session, safeName, _a, canceled, filePath, response, arrayBuffer, e_2, message;
    return __generator(this, function (_b) {
        switch (_b.label) {
            case 0:
                urlCheck = validateBaseUrl(payload.baseUrl);
                if (!urlCheck.valid) {
                    throw new Error(urlCheck.error || 'Invalid URL');
                }
                _b.label = 1;
            case 1:
                _b.trys.push([1, 6, , 7]);
                baseUrl = payload.baseUrl, profileId = payload.profileId, profileName = payload.profileName;
                session = getSession(baseUrl, payload.db);
                if (!session) {
                    throw new Error('Not authenticated');
                }
                safeName = profileName.replace(/[^a-zA-Z0-9_-]/g, '_');
                return [4 /*yield*/, dialog.showSaveDialog({
                        defaultPath: "".concat(safeName, ".zip"),
                        filters: [
                            { name: 'ZIP Files', extensions: ['zip'] }
                        ]
                    })];
            case 2:
                _a = _b.sent(), canceled = _a.canceled, filePath = _a.filePath;
                if (canceled || !filePath)
                    return [2 /*return*/, false];
                return [4 /*yield*/, fetch("".concat(baseUrl, "/ametras_fast_import/profile/").concat(profileId, "/export"), {
                        method: 'GET',
                        headers: {
                            'Cookie': "session_id=".concat(session.sessionId)
                        }
                    })];
            case 3:
                response = _b.sent();
                if (!response.ok) {
                    throw new Error("Export failed: ".concat(response.statusText));
                }
                return [4 /*yield*/, response.arrayBuffer()];
            case 4:
                arrayBuffer = _b.sent();
                return [4 /*yield*/, fs.writeFile(filePath, Buffer.from(arrayBuffer))];
            case 5:
                _b.sent();
                return [2 /*return*/, true];
            case 6:
                e_2 = _b.sent();
                message = e_2 instanceof Error ? e_2.message : 'Export failed';
                throw new Error(message, { cause: e_2 });
            case 7: return [2 /*return*/];
        }
    });
}); });
