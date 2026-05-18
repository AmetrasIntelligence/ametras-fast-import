'use strict'
// electron-builder afterPack hook — macOS ad-hoc deep re-sign.
//
// Problem: python-build-standalone ships Mach-O binaries with linker-applied
// ad-hoc signatures. electron-builder without a signing certificate produces
// an unsigned bundle, but macOS sees the signed nested binaries as inconsistent
// with the unsigned bundle and reports "damaged" — blocking "Open Anyway".
//
// Fix: after packing (but before any certificate-based signing), re-sign the
// entire .app with --force --deep --sign - so all nested binaries get a single
// consistent ad-hoc signature. The result is treated by macOS as "unidentified
// developer", which allows "Open Anyway" in System Settings → Privacy & Security.
//
// Note: afterSign is intentionally NOT used here — electron-builder v26 skips
// that hook when no signing certificate is present and logs a warning to use
// afterPack instead. If a real Developer ID certificate is later configured,
// electron-builder's own signing step runs after this hook and overrides it.

const { execSync } = require('child_process')
const path = require('path')

exports.default = async function afterPack(context) {
  if (context.electronPlatformName !== 'darwin') return

  const appName = context.packager.appInfo.productFilename
  const appPath = path.join(context.appOutDir, `${appName}.app`)

  execSync(`codesign --force --deep --sign - "${appPath}"`, { stdio: 'inherit' })
}
