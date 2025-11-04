import { createLogger } from '@/lib/logs/console/logger'
import { getBaseUrl } from '@/lib/urls/utils'
import type { InternalFileMetadata } from '@/executor/types'
import type { ExecutionContext } from './execution-file-helpers'
import {
  generateExecutionFileKey,
  generateFileId,
  getFileExpirationDate,
} from './execution-file-helpers'

const logger = createLogger('ExecutionFileStorage')

/**
 * Upload a file to execution-scoped storage
 * Returns internal metadata with storage key for operations
 */
export async function uploadExecutionFile(
  context: ExecutionContext,
  fileBuffer: Buffer,
  fileName: string,
  contentType: string
): Promise<InternalFileMetadata> {
  // Validate required context fields
  if (!context.userId) {
    throw new Error(
      `userId is required for uploading execution files. Context: ${JSON.stringify({
        workspaceId: context.workspaceId,
        workflowId: context.workflowId,
        executionId: context.executionId,
      })}`
    )
  }

  if (!context.workspaceId) {
    throw new Error(
      `workspaceId is required for uploading execution files. Context: ${JSON.stringify({
        userId: context.userId,
        workflowId: context.workflowId,
        executionId: context.executionId,
      })}`
    )
  }

  if (!context.executionId) {
    throw new Error(
      `executionId is required for uploading execution files. Context: ${JSON.stringify({
        userId: context.userId,
        workspaceId: context.workspaceId,
        workflowId: context.workflowId,
      })}`
    )
  }

  logger.info(`Uploading execution file: ${fileName} for execution ${context.executionId}`)
  logger.debug(`File upload context:`, {
    workspaceId: context.workspaceId,
    workflowId: context.workflowId,
    executionId: context.executionId,
    userId: context.userId,
    fileName,
    bufferSize: fileBuffer.length,
  })

  const storageKey = generateExecutionFileKey(context, fileName)
  const fileId = generateFileId()

  logger.info(`Generated storage key: "${storageKey}" for file: ${fileName}`)

  const metadata: Record<string, string> = {
    originalName: fileName,
    uploadedAt: new Date().toISOString(),
    purpose: 'execution',
    workspaceId: context.workspaceId,
  }

  if (context.userId) {
    metadata.userId = context.userId
  }

  try {
    const { uploadFile } = await import('@/lib/uploads/core/storage-service')
    const fileInfo = await uploadFile({
      file: fileBuffer,
      fileName: storageKey,
      contentType,
      context: 'execution',
      preserveKey: true, // Don't add timestamp prefix
      customKey: storageKey, // Use exact execution-scoped key
      metadata, // Pass metadata for cloud storage and database tracking
    })

    // Generate absolute URL for file access
    const baseUrl = getBaseUrl()
    const absoluteUrl = `${baseUrl}/api/files/serve/${fileInfo.key}`

    const fileMetadata: InternalFileMetadata = {
      id: fileId,
      name: fileName,
      size: fileBuffer.length,
      type: contentType,
      url: absoluteUrl,
      key: fileInfo.key,
      uploadedAt: new Date().toISOString(),
      expiresAt: getFileExpirationDate(),
      context: 'execution',
    }

    logger.info(`Successfully uploaded execution file: ${fileName} (${fileBuffer.length} bytes)`)
    logger.debug(`Generated absolute URL: ${absoluteUrl}`)
    return fileMetadata
  } catch (error) {
    logger.error(`Failed to upload execution file ${fileName}:`, error)
    throw new Error(
      `Failed to upload file: ${error instanceof Error ? error.message : 'Unknown error'}`
    )
  }
}

/**
 * Download a file from execution-scoped storage
 * Accepts InternalFileMetadata which contains the storage key
 */
export async function downloadExecutionFile(fileMetadata: InternalFileMetadata): Promise<Buffer> {
  logger.info(`Downloading execution file: ${fileMetadata.name}`)

  try {
    const { downloadFile } = await import('@/lib/uploads/core/storage-service')
    const fileBuffer = await downloadFile({
      key: fileMetadata.key,
      context: 'execution',
    })

    logger.info(
      `Successfully downloaded execution file: ${fileMetadata.name} (${fileBuffer.length} bytes)`
    )
    return fileBuffer
  } catch (error) {
    logger.error(`Failed to download execution file ${fileMetadata.name}:`, error)
    throw new Error(
      `Failed to download file: ${error instanceof Error ? error.message : 'Unknown error'}`
    )
  }
}

/**
 * Generate a short-lived presigned URL for file download (5 minutes)
 * Accepts InternalFileMetadata which contains the storage key
 */
export async function generateExecutionFileDownloadUrl(
  fileMetadata: InternalFileMetadata
): Promise<string> {
  logger.info(`Generating download URL for execution file: ${fileMetadata.name}`)
  logger.info(`File key: "${fileMetadata.key}"`)

  try {
    const { generatePresignedDownloadUrl } = await import('@/lib/uploads/core/storage-service')
    const downloadUrl = await generatePresignedDownloadUrl(
      fileMetadata.key,
      'execution',
      5 * 60 // 5 minutes
    )

    logger.info(`Generated download URL for execution file: ${fileMetadata.name}`)
    return downloadUrl
  } catch (error) {
    logger.error(`Failed to generate download URL for ${fileMetadata.name}:`, error)
    throw new Error(
      `Failed to generate download URL: ${error instanceof Error ? error.message : 'Unknown error'}`
    )
  }
}

/**
 * Delete a file from execution-scoped storage
 * Accepts InternalFileMetadata which contains the storage key
 */
export async function deleteExecutionFile(fileMetadata: InternalFileMetadata): Promise<void> {
  logger.info(`Deleting execution file: ${fileMetadata.name}`)

  try {
    const { deleteFile } = await import('@/lib/uploads/core/storage-service')
    await deleteFile({
      key: fileMetadata.key,
      context: 'execution',
    })

    logger.info(`Successfully deleted execution file: ${fileMetadata.name}`)
  } catch (error) {
    logger.error(`Failed to delete execution file ${fileMetadata.name}:`, error)
    throw new Error(
      `Failed to delete file: ${error instanceof Error ? error.message : 'Unknown error'}`
    )
  }
}
