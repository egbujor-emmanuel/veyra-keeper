import { put } from '@vercel/blob'
import { StorageProvider } from '@bnbagent/sdk/storage'

/**
 * Deliverable manifests on Vercel Blob, so the URL committed on chain is public and outlives any
 * one function invocation. The manifest's hash is what goes on chain; this only has to serve it.
 */
export class BlobStorageProvider extends StorageProvider {
  override readonly usesFileUrl = false

  async upload(data: Record<string, unknown>, filename?: string): Promise<string> {
    const name = `deliverables/${filename ?? `manifest-${Date.now()}.json`}`
    const blob = await put(name, JSON.stringify(data), { access: 'public', contentType: 'application/json', addRandomSuffix: true })
    return blob.url
  }

  async download(url: string): Promise<Record<string, unknown>> {
    const r = await fetch(url)
    if (!r.ok) throw new Error(`deliverable fetch failed: ${r.status}`)
    return (await r.json()) as Record<string, unknown>
  }

  async exists(url: string): Promise<boolean> {
    const r = await fetch(url, { method: 'HEAD' })
    return r.ok
  }
}

/** Write a small public JSON record (the keeper's action log). */
export async function putJson(path: string, data: unknown): Promise<string> {
  const blob = await put(path, JSON.stringify(data, null, 2), { access: 'public', contentType: 'application/json', addRandomSuffix: false, allowOverwrite: true, cacheControlMaxAge: 60 })
  return blob.url
}
