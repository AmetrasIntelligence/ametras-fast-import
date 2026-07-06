#!/usr/bin/env node
/**
 * Version-consistency guard (APX-3837).
 *
 * Single source of truth = the Odoo addon manifest, in canonical 5-segment
 * form `16.0.<major>.<minor>.<patch>`. The electron client and the vue-app
 * npm packages must carry exactly the trailing `<major>.<minor>.<patch>` as
 * their (semver) version, so the packaged app / installer / release artifacts
 * line up with what the UI shows (`__APP_VERSION__` = the full manifest
 * version).
 *
 * Fails (non-zero exit) if the manifest isn't 16.0.x.y.z or if either
 * package.json disagrees with the derived tail — so the two can never drift.
 *
 * Run: node ametras_fast_import_client/scripts/check-version.mjs
 */
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const repo = resolve(here, '..', '..') // .../csv-client

const manifestPath = resolve(repo, 'ametras_fast_import_addon/__manifest__.py')
const manifest = readFileSync(manifestPath, 'utf-8')
const m = manifest.match(/["']version["']\s*:\s*["']([^"']+)["']/)
if (!m) {
  console.error(`✗ No version found in ${manifestPath}`)
  process.exit(1)
}
const full = m[1]
const parts = full.split('.')
if (parts.length !== 5 || parts[0] !== '16' || parts[1] !== '0') {
  console.error(
    `✗ Manifest version must be "16.0.<major>.<minor>.<patch>", got "${full}".`
  )
  process.exit(1)
}
const tail = parts.slice(2).join('.') // major.minor.patch

let ok = true
for (const [label, rel] of [
  ['electron client', 'ametras_fast_import_client/package.json'],
  ['vue-app', 'ametras_fast_import_addon/vue-app/package.json'],
]) {
  const v = JSON.parse(readFileSync(resolve(repo, rel), 'utf-8')).version
  if (v !== tail) {
    console.error(
      `✗ ${label} package.json version "${v}" != derived "${tail}" ` +
        `(from manifest "${full}").`
    )
    ok = false
  } else {
    console.log(`✓ ${label}: ${v}`)
  }
}

if (!ok) {
  console.error(
    '\nFix: set both package.json versions to the manifest\'s trailing 3 ' +
      `segments ("${tail}"), or correct the manifest.`
  )
  process.exit(1)
}
console.log(`✓ versions consistent — manifest ${full} → app ${tail}`)
