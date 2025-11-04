'use server'

import type { Logger } from '@/lib/logs/console/logger'
import type { StorageContext } from '@/lib/uploads'
import type { InternalFileMetadata, UserFile } from '@/executor/types'
import { inferContextFromKey } from './file-utils'

/**
 * Check if a file is from execution storage based on its key pattern
 * Execution files have keys in format: workspaceId/workflowId/executionId/filename
 * Regular files have keys in format: timestamp-random-filename or just filename
 *
 * Note: Requires InternalFileMetadata (not UserFile) since it needs the key field
 */
function isExecutionFile(file: InternalFileMetadata): boolean {
  if (!file.key) {
    return false
  }

  // Execution files have at least 3 slashes in their key (4 parts)
  // e.g., "workspace123/workflow456/execution789/document.pdf"
  const parts = file.key.split('/')
  return parts.length >= 4 && !file.key.startsWith('/api/') && !file.key.startsWith('http')
}

/**
 * Download a file from a URL (internal or external)
 * For internal URLs, uses direct storage access (server-side only)
 * For external URLs, uses HTTP fetch
 */
export async function downloadFileFromUrl(fileUrl: string, timeoutMs = 180000): Promise<Buffer> {
  const { isInternalFileUrl } = await import('./file-utils')
  const { parseInternalFileUrl } = await import('./file-utils')
  const controller = new AbortController()
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs)

  try {
    if (isInternalFileUrl(fileUrl)) {
      const { key, context } = parseInternalFileUrl(fileUrl, 'knowledge-base')
      const { downloadFile } = await import('@/lib/uploads/core/storage-service')
      const buffer = await downloadFile({ key, context })
      clearTimeout(timeoutId)
      return buffer
    }

    const response = await fetch(fileUrl, { signal: controller.signal })
    clearTimeout(timeoutId)

    if (!response.ok) {
      throw new Error(`Failed to download file: ${response.statusText}`)
    }

    return Buffer.from(await response.arrayBuffer())
  } catch (error) {
    clearTimeout(timeoutId)
    if (error instanceof Error && error.name === 'AbortError') {
      throw new Error('File download timed out')
    }
    throw error
  }
}

/**
 * Helper to convert UserFile to InternalFileMetadata for download operations
 * This looks up the storage key from the database using the file ID
 */
async function ensureInternalMetadata(
  file: InternalFileMetadata | UserFile
): Promise<InternalFileMetadata> {
  // Check if it's already InternalFileMetadata (has key field)
  if ('key' in file && file.key) {
    return file as InternalFileMetadata
  }

  // It's a UserFile - need to look up the key from database
  const { userFileToInternal } = await import('@/lib/uploads/server/metadata')
  const internal = await userFileToInternal(file)

  if (!internal) {
    throw new Error(`Failed to lookup storage key for file: ${file.id}`)
  }

  return internal
}

/**
 * Downloads a file from storage (execution or regular)
 * @param fileMetadata - InternalFileMetadata object with storage key, or UserFile (will be converted)
 * @param requestId - Request ID for logging
 * @param logger - Logger instance
 * @returns Buffer containing file data
 */
export async function downloadFileFromStorage(
  file: InternalFileMetadata | UserFile,
  requestId: string,
  logger: Logger
): Promise<Buffer> {
  // Ensure we have internal metadata with storage key
  const fileMetadata = await ensureInternalMetadata(file)

  let buffer: Buffer

  if (isExecutionFile(fileMetadata)) {
    logger.info(`[${requestId}] Downloading from execution storage: ${fileMetadata.key}`)
    const { downloadExecutionFile } = await import(
      '@/lib/uploads/contexts/execution/execution-file-manager'
    )
    buffer = await downloadExecutionFile(fileMetadata)
  } else if (fileMetadata.key) {
    const context =
      (fileMetadata.context as StorageContext) || inferContextFromKey(fileMetadata.key)
    logger.info(
      `[${requestId}] Downloading from ${context} storage (${fileMetadata.context ? 'explicit' : 'inferred'}): ${fileMetadata.key}`
    )

    const { downloadFile } = await import('@/lib/uploads/core/storage-service')
    buffer = await downloadFile({
      key: fileMetadata.key,
      context,
    })
  } else {
    throw new Error('File has no key - cannot download')
  }

  return buffer
}
