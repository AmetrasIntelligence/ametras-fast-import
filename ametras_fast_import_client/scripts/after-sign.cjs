/**
 * electron-builder afterSign hook — macOS ad-hoc deep re-sign.
 *
 * Problem: python-build-standalone ships Mach-O binaries with linker-applied
 * ad-hoc signatures. When electron-builder bundles them into the .app and
 * produces an unsigned bundle (CSC_IDENTITY_AUTO_DISCOVERY=false), macOS sees
 * signed nested binaries inside an unsigned bundle and reports the app as
 * "damaged" — bypassing Gatekeeper via "Open Anyway" no longer works.
 *
 * Fix: after electron-builder finishes packaging, re-sign the entire .app with
 * a single consistent ad-hoc signature using --force --deep. This overwrites
 * all nested binary signatures so the bundle is coherent. The result is treated
 * by macOS as "unidentified developer" (not notarized), which allows
 * "Open Anyway" in System Settings → Privacy & Security.
 */
'use strict'

const { execSync } = require('child_process')
const path = require('path')

exports.default = async function afterSign(context) {
  if (context.electronPlatformName !== 'darwin') return

  const appName = context.packager.appInfo.productFilename
  const appPath = path.join(context.appOutDir, `${appName}.app`)

  console.log(`==> afterSign: deep ad-hoc re-sign "${appPath}"`)
  execSync(`codesign --force --deep --sign - "${appPath}"`, { stdio: 'inherit' })
  console.log('==> afterSign: done')
}
