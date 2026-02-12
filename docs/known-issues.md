# Known Issues

## Status Summary

| Issue | Status | Resolution |
|-------|--------|------------|
| Autofill errors | Ignored | Cosmetic only, no impact |
| Preload script | **RESOLVED** | Using plain CommonJS preload.cjs |
| vue-i18n error | **RESOLVED** | Upgraded to vue-i18n v11 with npm override |

---

## 1. Electron DevTools Autofill Errors

### Status: Ignored (Cosmetic)

### Observed Errors

```
Request Autofill.enable failed. {"code":-32601,"message":"'Autofill.enable' wasn't found"}
Request Autofill.setAddresses failed. {"code":-32601,"message":"'Autofill.setAddresses' wasn't found"}
```

### Cause

When DevTools opens in development mode, the DevTools frontend attempts to enable Chrome's Autofill debugging features via the Chrome DevTools Protocol (CDP). Electron doesn't implement the `Autofill` CDP domain.

### Impact

**None.** These errors:
- Do not affect application functionality
- Only appear in development mode (when DevTools is open)
- Will not appear in production builds

### Resolution

Ignored - standard behavior for Electron apps.

---

## 2. Preload Script Load Failure

### Status: RESOLVED

### Original Error

```
Unable to load preload script: .../dist-electron/preload.cjs
SyntaxError: Cannot use import statement outside a module
```

### Cause

The Vite build was outputting ES module syntax (`import`) instead of CommonJS (`require`) for the preload script, which Electron's sandboxed preload environment doesn't support.

### Resolution

Created a plain JavaScript CommonJS preload script (`electron/preload.cjs`) and configured Vite to copy it directly instead of building it:

**File:** `electron/preload.cjs`
```javascript
const { contextBridge, ipcRenderer, webUtils } = require('electron');

contextBridge.exposeInMainWorld('api', {
  // ... API definitions
});
```

**File:** `vite.config.ts`
```typescript
function copyPreload() {
  return {
    name: 'copy-preload',
    writeBundle() {
      const src = path.resolve(__dirname, 'electron/preload.cjs')
      const dest = path.resolve(__dirname, 'dist-electron/preload.cjs')
      fs.mkdirSync(path.dirname(dest), { recursive: true })
      fs.copyFileSync(src, dest)
    }
  }
}
```

---

## 3. vue-i18n Composer Error

### Status: RESOLVED

### Original Error

```
[ErrorBoundary] Uncaught error in component
error: "Unexpected return type in composer"
```

### Cause

Version mismatch between vue-i18n packages. The runtime-only build was conflicting with different versions installed by dependencies.

### Resolution

1. Upgraded to vue-i18n v11 (`"vue-i18n": "^11.2.8"`)
2. Added npm override to force unified version:

**File:** `package.json`
```json
{
  "overrides": {
    "vue-i18n": "^11.2.8"
  }
}
```

3. Configured VueI18nPlugin with `runtimeOnly: true` for pre-compilation:

**File:** `vite.config.ts`
```typescript
VueI18nPlugin({
  include: [path.resolve(__dirname, 'src/i18n/locales/**')],
  strictMessage: false,
  escapeHtml: false,
  runtimeOnly: true
}),
```

---

## Verification

All fixes verified working:
- Build completes successfully (`npm run build`)
- All 543 unit tests pass (`npm run test:unit`)
- Preload script uses correct CommonJS syntax
- vue-i18n v11 with unified version across dependencies
