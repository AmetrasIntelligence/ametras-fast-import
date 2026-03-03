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
import { randomUUID } from 'crypto';
import path from 'path';
import fs from 'fs/promises';
import { createReadStream, realpathSync } from 'fs';
import readline from 'readline';
import { Buffer } from 'buffer';
var fileRegistry = new Map();
/**
 * Validate file path to prevent path traversal attacks.
 * - Checks for path traversal patterns and null bytes
 * - Ensures path is absolute
 * - Resolves symlinks to get real path
 * - Verifies file exists and is a regular file
 */
function validateFilePath(filePath) {
    return __awaiter(this, void 0, void 0, function () {
        var resolvedPath, stats, error_1, message;
        return __generator(this, function (_a) {
            switch (_a.label) {
                case 0:
                    // Check for null bytes (potential injection)
                    if (filePath.includes('\0')) {
                        return [2 /*return*/, { valid: false, error: 'Path contains null bytes' }];
                    }
                    // Ensure it's an absolute path
                    if (!path.isAbsolute(filePath)) {
                        return [2 /*return*/, { valid: false, error: 'Path must be absolute' }];
                    }
                    // Check for obvious path traversal patterns
                    if (filePath.includes('..')) {
                        return [2 /*return*/, { valid: false, error: 'Path contains traversal patterns' }];
                    }
                    _a.label = 1;
                case 1:
                    _a.trys.push([1, 3, , 4]);
                    resolvedPath = realpathSync(filePath);
                    return [4 /*yield*/, fs.stat(resolvedPath)];
                case 2:
                    stats = _a.sent();
                    if (!stats.isFile()) {
                        return [2 /*return*/, { valid: false, error: 'Path is not a regular file' }];
                    }
                    return [2 /*return*/, { valid: true, resolvedPath: resolvedPath }];
                case 3:
                    error_1 = _a.sent();
                    message = error_1 instanceof Error ? error_1.message : 'Path validation failed';
                    return [2 /*return*/, { valid: false, error: message }];
                case 4: return [2 /*return*/];
            }
        });
    });
}
/**
 * Synchronous path validation for simple checks (used in filters).
 * For full validation including symlink resolution, use validateFilePath().
 */
function validateFilePathSync(filePath) {
    // Quick checks only - full validation happens in async version
    if (filePath.includes('\0') || filePath.includes('..') || !path.isAbsolute(filePath)) {
        return false;
    }
    return true;
}
// Supported encodings mapped to Node.js encoding names
var ENCODING_MAP = {
    'utf-8': 'utf-8',
    'utf-8-sig': 'utf-8', // BOM will be stripped separately
    'latin-1': 'latin1',
    'cp1252': 'latin1' // Close approximation
};
/**
 * Strip UTF-8 BOM if present at the start of content.
 */
function stripBOM(content) {
    if (content.charCodeAt(0) === 0xFEFF) {
        return content.slice(1);
    }
    return content;
}
/**
 * Detect line ending style from content sample.
 */
function detectLineEnding(content) {
    if (content.includes('\r\n'))
        return '\r\n';
    if (content.includes('\r'))
        return '\r';
    return '\n';
}
// Register files by their paths (for drag-and-drop)
ipcMain.handle('files:register', function (_event, filePaths) { return __awaiter(void 0, void 0, void 0, function () {
    var handles, _i, filePaths_1, filePath, validation, id, stats;
    return __generator(this, function (_a) {
        switch (_a.label) {
            case 0:
                handles = [];
                _i = 0, filePaths_1 = filePaths;
                _a.label = 1;
            case 1:
                if (!(_i < filePaths_1.length)) return [3 /*break*/, 5];
                filePath = filePaths_1[_i];
                // Quick sync check first
                if (!filePath.toLowerCase().endsWith('.csv'))
                    return [3 /*break*/, 4];
                if (!validateFilePathSync(filePath))
                    return [3 /*break*/, 4];
                return [4 /*yield*/, validateFilePath(filePath)];
            case 2:
                validation = _a.sent();
                if (!validation.valid || !validation.resolvedPath) {
                    console.warn("[files] Rejected path: ".concat(filePath, " - ").concat(validation.error));
                    return [3 /*break*/, 4];
                }
                id = randomUUID();
                return [4 /*yield*/, fs.stat(validation.resolvedPath)
                    // Store the resolved (real) path, not the symlinked path
                ];
            case 3:
                stats = _a.sent();
                // Store the resolved (real) path, not the symlinked path
                fileRegistry.set(id, validation.resolvedPath);
                handles.push({
                    id: id,
                    name: path.basename(filePath), // Keep original name for display
                    size: stats.size
                });
                _a.label = 4;
            case 4:
                _i++;
                return [3 /*break*/, 1];
            case 5: return [2 /*return*/, handles];
        }
    });
}); });
ipcMain.handle('files:select', function () { return __awaiter(void 0, void 0, void 0, function () {
    var _a, canceled, filePaths, handles, _i, filePaths_2, filePath, validation, id, stats;
    return __generator(this, function (_b) {
        switch (_b.label) {
            case 0: return [4 /*yield*/, dialog.showOpenDialog({
                    properties: ['openFile', 'multiSelections'],
                    filters: [
                        { name: 'CSV Files', extensions: ['csv'] },
                        { name: 'All Files', extensions: ['*'] }
                    ]
                })];
            case 1:
                _a = _b.sent(), canceled = _a.canceled, filePaths = _a.filePaths;
                if (canceled)
                    return [2 /*return*/, []];
                handles = [];
                _i = 0, filePaths_2 = filePaths;
                _b.label = 2;
            case 2:
                if (!(_i < filePaths_2.length)) return [3 /*break*/, 6];
                filePath = filePaths_2[_i];
                return [4 /*yield*/, validateFilePath(filePath)];
            case 3:
                validation = _b.sent();
                if (!validation.valid || !validation.resolvedPath) {
                    console.warn("[files:select] Rejected path: ".concat(filePath, " - ").concat(validation.error));
                    return [3 /*break*/, 5];
                }
                id = randomUUID();
                return [4 /*yield*/, fs.stat(validation.resolvedPath)
                    // Store the resolved (real) path, not the potentially symlinked path
                ];
            case 4:
                stats = _b.sent();
                // Store the resolved (real) path, not the potentially symlinked path
                fileRegistry.set(id, validation.resolvedPath);
                handles.push({
                    id: id,
                    name: path.basename(filePath), // Keep original name for display
                    size: stats.size
                });
                _b.label = 5;
            case 5:
                _i++;
                return [3 /*break*/, 2];
            case 6: return [2 /*return*/, handles];
        }
    });
}); });
// Full file read (for small files / analysis)
ipcMain.handle('files:read', function (_event, id, encoding) { return __awaiter(void 0, void 0, void 0, function () {
    var filePath, nodeEncoding, content;
    return __generator(this, function (_a) {
        switch (_a.label) {
            case 0:
                filePath = fileRegistry.get(id);
                if (!filePath)
                    throw new Error("Unknown file ID: ".concat(id));
                nodeEncoding = ENCODING_MAP[encoding || 'utf-8'] || 'utf-8';
                return [4 /*yield*/, fs.readFile(filePath, nodeEncoding)
                    // Strip BOM for utf-8-sig
                ];
            case 1:
                content = _a.sent();
                // Strip BOM for utf-8-sig
                if (encoding === 'utf-8-sig' || encoding === 'utf-8') {
                    content = stripBOM(content);
                }
                return [2 /*return*/, content];
        }
    });
}); });
// Read only first N bytes (for analysis)
ipcMain.handle('files:readHead', function (_event, id, bytes, encoding) { return __awaiter(void 0, void 0, void 0, function () {
    var filePath, handle, buffer, bytesRead, nodeEncoding, content;
    return __generator(this, function (_a) {
        switch (_a.label) {
            case 0:
                filePath = fileRegistry.get(id);
                if (!filePath)
                    throw new Error("Unknown file ID: ".concat(id));
                return [4 /*yield*/, fs.open(filePath, 'r')];
            case 1:
                handle = _a.sent();
                buffer = Buffer.alloc(bytes);
                return [4 /*yield*/, handle.read(buffer, 0, bytes, 0)];
            case 2:
                bytesRead = (_a.sent()).bytesRead;
                return [4 /*yield*/, handle.close()];
            case 3:
                _a.sent();
                nodeEncoding = ENCODING_MAP[encoding || 'utf-8'] || 'utf-8';
                content = buffer.toString(nodeEncoding, 0, bytesRead);
                // Strip BOM for utf-8-sig
                if (encoding === 'utf-8-sig' || encoding === 'utf-8') {
                    content = stripBOM(content);
                }
                return [2 /*return*/, content];
        }
    });
}); });
// Count lines efficiently (streaming)
ipcMain.handle('files:countLines', function (_event, id) { return __awaiter(void 0, void 0, void 0, function () {
    var filePath;
    return __generator(this, function (_a) {
        filePath = fileRegistry.get(id);
        if (!filePath)
            throw new Error("Unknown file ID: ".concat(id));
        return [2 /*return*/, new Promise(function (resolve, reject) {
                var count = 0;
                var stream = createReadStream(filePath, { encoding: 'utf-8' });
                var rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
                rl.on('line', function () { return count++; });
                rl.on('close', function () { return resolve(count); });
                rl.on('error', reject);
            })];
    });
}); });
// Stream file in chunks for processing
ipcMain.handle('files:streamChunks', function (event, id, chunkLines, encoding) { return __awaiter(void 0, void 0, void 0, function () {
    var filePath, streamId, nodeEncoding, stream, rl, chunk, isFirstChunk, headerLine, lineEnding, bomStripped;
    return __generator(this, function (_a) {
        filePath = fileRegistry.get(id);
        if (!filePath)
            throw new Error("Unknown file ID: ".concat(id));
        streamId = randomUUID();
        nodeEncoding = ENCODING_MAP[encoding || 'utf-8'] || 'utf-8';
        stream = createReadStream(filePath, { encoding: nodeEncoding });
        rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
        chunk = [];
        isFirstChunk = true;
        headerLine = '';
        lineEnding = '\n' // Default, will be detected from first line
        ;
        bomStripped = false;
        rl.on('line', function (line) {
            var processedLine = line;
            // Strip BOM from first line if present
            if (isFirstChunk && chunk.length === 0 && !bomStripped) {
                processedLine = stripBOM(line);
                bomStripped = true;
                // Detect line ending from raw file content (check first few KB)
                // We use \n as default since readline strips endings, but we'll
                // use \n universally for CSV parsing (PapaParse handles both)
            }
            if (isFirstChunk && chunk.length === 0) {
                headerLine = processedLine;
            }
            chunk.push(processedLine);
            if (chunk.length >= chunkLines) {
                // Use \n for joining - PapaParse handles line endings internally
                var data = isFirstChunk ? chunk.join('\n') : headerLine + '\n' + chunk.join('\n');
                event.sender.send("files:chunk:".concat(streamId), { data: data, done: false });
                chunk = [];
                isFirstChunk = false;
            }
        });
        rl.on('close', function () {
            if (chunk.length > 0) {
                var data = isFirstChunk ? chunk.join('\n') : headerLine + '\n' + chunk.join('\n');
                event.sender.send("files:chunk:".concat(streamId), { data: data, done: false });
            }
            event.sender.send("files:chunk:".concat(streamId), { data: '', done: true });
        });
        rl.on('error', function (err) {
            event.sender.send("files:chunk:".concat(streamId), { error: err.message, done: true });
        });
        return [2 /*return*/, streamId];
    });
}); });
/**
 * Async streaming with backpressure support.
 * Uses request-reply pattern: renderer requests each chunk, processes it,
 * then requests next. Prevents memory buildup from fast streaming.
 */
var activeStreams = new Map();
ipcMain.handle('files:streamStart', function (_event, id, chunkLines, encoding) { return __awaiter(void 0, void 0, void 0, function () {
    var filePath, streamId, nodeEncoding, stream, rl, state, currentChunk, isFirstLine, bomStripped;
    return __generator(this, function (_a) {
        filePath = fileRegistry.get(id);
        if (!filePath)
            throw new Error("Unknown file ID: ".concat(id));
        streamId = randomUUID();
        nodeEncoding = ENCODING_MAP[encoding || 'utf-8'] || 'utf-8';
        stream = createReadStream(filePath, { encoding: nodeEncoding });
        rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
        state = {
            rl: rl,
            headerLine: '',
            buffer: [],
            done: false,
            error: undefined
        };
        currentChunk = [];
        isFirstLine = true;
        bomStripped = false;
        rl.on('line', function (line) {
            var processedLine = line;
            // Strip BOM from first line if present
            if (isFirstLine && !bomStripped) {
                processedLine = stripBOM(line);
                bomStripped = true;
                state.headerLine = processedLine;
                isFirstLine = false;
            }
            currentChunk.push(processedLine);
            if (currentChunk.length >= chunkLines) {
                state.buffer.push(currentChunk);
                currentChunk = [];
                // Pause stream if buffer gets too large (backpressure)
                if (state.buffer.length >= 3) {
                    rl.pause();
                }
            }
        });
        rl.on('close', function () {
            if (currentChunk.length > 0) {
                state.buffer.push(currentChunk);
            }
            state.done = true;
        });
        rl.on('error', function (err) {
            state.error = err.message;
            state.done = true;
        });
        activeStreams.set(streamId, state);
        return [2 /*return*/, streamId];
    });
}); });
ipcMain.handle('files:streamNext', function (_event, streamId) { return __awaiter(void 0, void 0, void 0, function () {
    var state, chunk, isFirstChunk, data;
    return __generator(this, function (_a) {
        switch (_a.label) {
            case 0:
                state = activeStreams.get(streamId);
                if (!state)
                    throw new Error("Unknown stream ID: ".concat(streamId));
                _a.label = 1;
            case 1:
                if (!(state.buffer.length === 0 && !state.done)) return [3 /*break*/, 3];
                state.rl.resume();
                return [4 /*yield*/, new Promise(function (resolve) { return setTimeout(resolve, 10); })];
            case 2:
                _a.sent();
                return [3 /*break*/, 1];
            case 3:
                if (state.error) {
                    activeStreams.delete(streamId);
                    return [2 /*return*/, { error: state.error, done: true }];
                }
                if (state.buffer.length > 0) {
                    chunk = state.buffer.shift();
                    isFirstChunk = chunk[0] === state.headerLine;
                    data = isFirstChunk ? chunk.join('\n') : state.headerLine + '\n' + chunk.join('\n');
                    // Resume stream if buffer low
                    if (state.buffer.length < 2) {
                        state.rl.resume();
                    }
                    return [2 /*return*/, { data: data, done: false }];
                }
                // Done
                activeStreams.delete(streamId);
                return [2 /*return*/, { data: '', done: true }];
        }
    });
}); });
ipcMain.handle('files:streamClose', function (_event, streamId) { return __awaiter(void 0, void 0, void 0, function () {
    var state;
    return __generator(this, function (_a) {
        state = activeStreams.get(streamId);
        if (state) {
            state.rl.close();
            activeStreams.delete(streamId);
        }
        return [2 /*return*/];
    });
}); });
export function clearFileRegistry() {
    fileRegistry.clear();
    // Clean up any active streams
    for (var _i = 0, activeStreams_1 = activeStreams; _i < activeStreams_1.length; _i++) {
        var _a = activeStreams_1[_i], state = _a[1];
        state.rl.close();
    }
    activeStreams.clear();
}
