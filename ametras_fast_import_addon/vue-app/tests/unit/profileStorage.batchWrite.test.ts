import { describe, it, expect, beforeEach, vi } from 'vitest'
import JSZip from 'jszip'
import { mockApi } from '../setup'

async function profileZip(runSettings: string | null): Promise<File> {
  const zip = new JSZip()
  zip.file('profile.csv', 'key,value\nname,Prices')
  zip.file('mappings.csv', 'filename,model\nprices.csv,product.supplierinfo')
  zip.file('sequence.csv', 'order,filename\n1,prices.csv')
  if (runSettings !== null) zip.file('run_settings.csv', runSettings)
  const blob = await zip.generateAsync({ type: 'blob' })
  return new File([blob], 'prices.zip', { type: 'application/zip' })
}

describe('importStandaloneProfile: batched writes', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockApi.store.get.mockResolvedValue(null)
    mockApi.store.set.mockResolvedValue(undefined)
  })

  it('switches batched writes on when the profile says so', async () => {
    const { importStandaloneProfile } = await import('@/api/profileStorage')
    const profile = await importStandaloneProfile(
      await profileZip('key,value\nbatchSize,200\nbatchWrite,true')
    )
    expect(profile.runSettings.batchWrite).toBe(true)
  })

  it('keeps batched writes off by default', async () => {
    const { importStandaloneProfile } = await import('@/api/profileStorage')
    const profile = await importStandaloneProfile(await profileZip('key,value\nbatchSize,200'))
    expect(profile.runSettings.batchWrite).toBe(false)
  })
})
