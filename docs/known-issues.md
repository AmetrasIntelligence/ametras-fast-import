# Known Issues

## 1. Electron DevTools Autofill Errors

### Observed Errors

```
Request Autofill.enable failed. {"code":-32601,"message":"'Autofill.enable' wasn't found"}
Request Autofill.setAddresses failed. {"code":-32601,"message":"'Autofill.setAddresses' wasn't found"}
```

### Cause

When DevTools opens in development mode (`electron/main.ts:31`), the DevTools frontend attempts to enable Chrome's Autofill debugging features via the Chrome DevTools Protocol (CDP).

Electron doesn't implement the `Autofill` CDP domain because:
1. Electron apps don't use Chrome's built-in password/address autofill system
2. The `sandbox: true` webPreferences option further restricts these features

### Impact

**None.** These errors:
- Do not affect application functionality
- Only appear in development mode (when DevTools is open)
- Will not appear in production builds

### Suggestions

| Option | Description | Recommended |
|--------|-------------|-------------|
| Ignore | Standard approach for Electron apps | Yes |
| Filter in DevTools | Add `-Autofill` filter in Console tab | Optional |

---

## 2. Preload Script Load Failure

### Observed Errors

```
Unable to load preload script: .../dist-electron/preload.cjs
SyntaxError: Cannot use import statement outside a module
```

### Cause

The preload script (`electron/preload.ts`) uses ES module `import` syntax:

```typescript
import { contextBridge, ipcRenderer, webUtils } from 'electron'
```

But the Vite config (`vite.config.ts:40-43`) compiles it to CommonJS format:

```typescript
lib: {
  formats: ['cjs'],
  fileName: () => 'preload.cjs'
}
```

The `commonjsOptions: { transformMixedEsModules: true }` setting is not properly transforming ES imports to CommonJS `require()` calls in the output.

### Impact

**Critical in development.** The preload script fails to load, which means:
- `window.api` is undefined
- All IPC calls (file handling, Odoo API, store) fail
- The app cannot function

### Suggestions

| Option | Description | Complexity |
|--------|-------------|------------|
| Rewrite preload to CommonJS | Use `require()` instead of `import` | Low |
| Fix Vite/Rollup config | Ensure ESM→CJS transform works | Medium |
| Switch to ESM preload | Change to `preload.mjs`, update main.ts reference | Medium |

**Option 1 - Rewrite to CommonJS (recommended):**
```typescript
const { contextBridge, ipcRenderer, webUtils } = require('electron')
```

**Option 2 - Fix build config:**
Add explicit transform in `vite.config.ts`:
```typescript
build: {
  rollupOptions: {
    output: {
      format: 'cjs',
      exports: 'auto'
    }
  }
}
```

---

## 3. vue-i18n Composer Error

### Observed Errors

```
[ErrorBoundary] Uncaught error in component
error: "Unexpected return type in composer"
at LoginView.vue:147:33
```

### Cause

The app uses the vue-i18n **runtime-only build** (`vite.config.ts:62`):

```typescript
'vue-i18n': 'vue-i18n/dist/vue-i18n.runtime.esm-bundler.js'
```

The runtime-only build expects all message strings to be pre-compiled by `@intlify/unplugin-vue-i18n`. However, when messages are loaded dynamically at runtime (via `createI18n({ messages: { de, en } })`), they need runtime compilation which isn't available.

The error occurs in the template:
```vue
{{ profile.name }} ({{ profile.db }}@{{ profile.baseUrl }})
```

This is NOT inside a `$t()` call, but the error suggests vue-i18n's composer is still being invoked somewhere in the component render.

### Impact

**Critical.** ErrorBoundary catches and displays error, blocking the login page.

### Suggestions

| Option | Description | Trade-off |
|--------|-------------|-----------|
| Use full vue-i18n build | Remove alias in vite.config.ts | Larger bundle (+~15KB) |
| Pre-compile messages | Configure VueI18nPlugin properly | Build complexity |
| Debug specific translation | Find which `$t()` call fails | Quick fix |

**Option 1 - Use full build (recommended for debugging):**

Remove or comment out line 62 in `vite.config.ts`:
```typescript
// 'vue-i18n': 'vue-i18n/dist/vue-i18n.runtime.esm-bundler.js'
```

**Option 2 - Check locale files for syntax issues:**

Common vue-i18n message syntax issues:
- Unescaped `@` (use `{'@'}` instead)
- Unescaped `|` in pluralization
- Mismatched `{` `}` braces
- Invalid linked message syntax (`@:key`)

The locale file already escapes `@` in `usernamePlaceholder`:
```json
"usernamePlaceholder": "admin{'@'}example.com"
```

Check if any other messages have unescaped special characters.

---

## Summary

| Issue | Severity | Action |
|-------|----------|--------|
| Autofill errors | Low (cosmetic) | Ignore |
| Preload script | Critical | Fix build or rewrite to CJS |
| vue-i18n error | Critical | Switch to full build or fix messages |
