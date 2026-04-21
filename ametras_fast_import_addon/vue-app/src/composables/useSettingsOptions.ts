import { computed } from 'vue'
import { useI18n } from 'vue-i18n'

export function useSettingsOptions() {
  const { t } = useI18n()

  const delimiterOptions = computed(() => [
    { value: ',', label: t('settings.delimiter_options.comma') },
    { value: ';', label: t('settings.delimiter_options.semicolon') },
    { value: '\t', label: t('settings.delimiter_options.tab') },
    { value: '', label: t('settings.delimiter_options.auto') }
  ])

  const encodingOptions = computed(() => [
    { value: 'utf-8', label: t('settings.encoding_options.utf-8') },
    { value: 'utf-8-sig', label: t('settings.encoding_options.utf-8-sig') },
    { value: 'latin-1', label: t('settings.encoding_options.latin-1') },
    { value: 'cp1252', label: t('settings.encoding_options.cp1252') }
  ])

  return { delimiterOptions, encodingOptions }
}
