import { describe, it, expect } from 'vitest'
import JSZip from 'jszip'
import { importProfileFromZip, exportProfileToZip } from '@/utils/profileUtils'

describe('importProfileFromZip', () => {
  it('extracts CSV files from ZIP', async () => {
    const zip = new JSZip()
    zip.file('profile.csv', 'key,value\nname,Test')
    zip.file('mappings.csv', 'filename,model\npartners.csv,res.partner')
    zip.file('sequence.csv', 'order,filename\n1,partners.csv')

    const blob = await zip.generateAsync({ type: 'blob' })
    const file = new File([blob], 'test.zip', { type: 'application/zip' })

    const result = await importProfileFromZip(file)

    expect(result['profile.csv']).toContain('name,Test')
    expect(result['mappings.csv']).toContain('partners.csv')
    expect(result['sequence.csv']).toContain('1,partners.csv')
  })

  it('includes optional files when present', async () => {
    const zip = new JSZip()
    zip.file('profile.csv', 'key,value\nname,Test')
    zip.file('mappings.csv', 'filename,model\npartners.csv,res.partner')
    zip.file('sequence.csv', 'order,filename\n1,partners.csv')
    zip.file('run_settings.csv', 'key,value\nbatchSize,200')
    zip.file('field_mappings.csv', 'filename,csv_column,odoo_field\npartners.csv,name,name')

    const blob = await zip.generateAsync({ type: 'blob' })
    const file = new File([blob], 'test.zip', { type: 'application/zip' })

    const result = await importProfileFromZip(file)

    expect(result['run_settings.csv']).toContain('batchSize,200')
    expect(result['field_mappings.csv']).toContain('partners.csv,name,name')
  })

  it('throws for missing required files', async () => {
    const zip = new JSZip()
    zip.file('profile.csv', 'key,value\nname,Test')
    // Missing mappings.csv and sequence.csv

    const blob = await zip.generateAsync({ type: 'blob' })
    const file = new File([blob], 'test.zip', { type: 'application/zip' })

    await expect(importProfileFromZip(file)).rejects.toThrow('Missing required file in ZIP: mappings.csv')
  })

  it('handles nested files by extracting basename', async () => {
    const zip = new JSZip()
    const folder = zip.folder('profile')!
    folder.file('profile.csv', 'key,value\nname,Nested')
    folder.file('mappings.csv', 'filename,model\npartners.csv,res.partner')
    folder.file('sequence.csv', 'order,filename\n1,partners.csv')

    const blob = await zip.generateAsync({ type: 'blob' })
    const file = new File([blob], 'test.zip', { type: 'application/zip' })

    const result = await importProfileFromZip(file)

    expect(result['profile.csv']).toContain('name,Nested')
  })
})

describe('exportProfileToZip', () => {
  it('creates a ZIP with all CSV files', async () => {
    const csvFiles = {
      'profile.csv': 'key,value\nname,Export Test',
      'mappings.csv': 'filename,model\npartners.csv,res.partner',
      'sequence.csv': 'order,filename\n1,partners.csv'
    }

    const blob = await exportProfileToZip(csvFiles, 'Export Test')
    expect(blob).toBeInstanceOf(Blob)

    // Verify contents by reading back
    const zip = await JSZip.loadAsync(blob)
    const profileContent = await zip.file('profile.csv')!.async('string')
    expect(profileContent).toContain('name,Export Test')

    const mappingsContent = await zip.file('mappings.csv')!.async('string')
    expect(mappingsContent).toContain('partners.csv,res.partner')
  })

  it('includes optional files', async () => {
    const csvFiles = {
      'profile.csv': 'key,value\nname,Test',
      'mappings.csv': 'filename,model',
      'sequence.csv': 'order,filename',
      'run_settings.csv': 'key,value\nbatchSize,200',
      'field_mappings.csv': 'filename,csv_column,odoo_field'
    }

    const blob = await exportProfileToZip(csvFiles, 'Test')
    const zip = await JSZip.loadAsync(blob)

    expect(zip.file('run_settings.csv')).not.toBeNull()
    expect(zip.file('field_mappings.csv')).not.toBeNull()
  })

  it('roundtrips import/export', async () => {
    const originalFiles = {
      'profile.csv': 'key,value\nname,Roundtrip Test\nversion,2.0',
      'mappings.csv': 'filename,model\npartners.csv,res.partner\nproducts.csv,product.template',
      'sequence.csv': 'order,filename\n1,partners.csv\n2,products.csv',
      'run_settings.csv': 'key,value\nbatchSize,300'
    }

    // Export to ZIP
    const blob = await exportProfileToZip(originalFiles, 'Roundtrip')
    const file = new File([blob], 'roundtrip.zip', { type: 'application/zip' })

    // Import from ZIP
    const importedFiles = await importProfileFromZip(file)

    expect(importedFiles['profile.csv']).toBe(originalFiles['profile.csv'])
    expect(importedFiles['mappings.csv']).toBe(originalFiles['mappings.csv'])
    expect(importedFiles['sequence.csv']).toBe(originalFiles['sequence.csv'])
    expect(importedFiles['run_settings.csv']).toBe(originalFiles['run_settings.csv'])
  })
})
