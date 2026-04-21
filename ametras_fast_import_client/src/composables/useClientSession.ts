/**
 * Client-side session management for Electron login flow.
 *
 * This composable wraps the shared session store with Electron-specific
 * logic: IPC-based authentication, saved connection profiles, and
 * batch size clamping for standalone mode.
 */

import { useSessionStore, type ServerProfile } from '@/stores/session'
import { useConfigStore } from '@/stores/config'

export function useClientSession() {
  const session = useSessionStore()

  async function login(profile: ServerProfile, password: string) {
    // IPC errors propagate naturally as rejections
    const result = await window.api.odoo.authenticate({
      baseUrl: profile.baseUrl,
      db: profile.db,
      login: profile.name,
      password
    })

    if (!result.ok) {
      throw new Error(result.error || 'Authentication failed')
    }

    session.setAuthenticated(profile, result.uid ?? 0, result.server_version ?? '')

    // Update or add connection profile (without password)
    const existingIdx = session.savedProfiles.findIndex(
      p => p.baseUrl === profile.baseUrl && p.db === profile.db
    )
    if (existingIdx >= 0) {
      session.savedProfiles[existingIdx] = profile
    } else {
      session.savedProfiles.push(profile)
    }
    // Convert to plain objects for IPC (Vue proxies can't be cloned)
    try {
      await window.api.store.set('profiles', JSON.parse(JSON.stringify(session.savedProfiles)))
    } catch {
      // Profile save failure is non-fatal — user is already logged in
    }

    // Clamp batch size to reasonable limits
    const config = useConfigStore()
    if (config.settings.batchSize > 1000) {
      config.setSettings({ batchSize: 1000 })
    }
  }

  return { login }
}
