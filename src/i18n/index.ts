import { createI18n } from 'vue-i18n'
import de from './locales/de.json'
import en from './locales/en.json'

export type SupportedLocale = 'de' | 'en'

export const SUPPORTED_LOCALES: { code: SupportedLocale; name: string }[] = [
  { code: 'de', name: 'Deutsch' },
  { code: 'en', name: 'English' }
]

// Get stored locale or default to German
function getStoredLocale(): SupportedLocale {
  if (typeof localStorage !== 'undefined') {
    const stored = localStorage.getItem('csv-import-locale')
    if (stored === 'de' || stored === 'en') {
      return stored
    }
  }
  return 'de' // Default to German
}

export const i18n = createI18n({
  legacy: false, // Use Composition API
  locale: getStoredLocale(),
  fallbackLocale: 'de',
  messages: {
    de,
    en
  }
})

/**
 * Change the current locale and persist the choice.
 */
export function setLocale(locale: SupportedLocale): void {
  i18n.global.locale.value = locale
  if (typeof localStorage !== 'undefined') {
    localStorage.setItem('csv-import-locale', locale)
  }
}

/**
 * Get the current locale.
 */
export function getLocale(): SupportedLocale {
  return i18n.global.locale.value as SupportedLocale
}
