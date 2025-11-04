import { createLogger } from '@/lib/logs/console/logger'
import { uploadExecutionFile } from '@/lib/uploads/contexts/execution'
import type { ExecutionContext, UserFile } from '@/executor/types'
import { toUserFile } from '@/executor/types'
import type { ToolConfig, ToolFileData } from '@/tools/types'

const logger = createLogger('FileToolProcessor')

/**
 * Processes tool outputs and converts file-typed outputs to UserFile objects.
 * This enables tools to return file data that gets automatically stored in the
 * execution filesystem and made available as UserFile objects for workflow use.
 */
export class FileToolProcessor {
  /**
   * Process tool outputs and convert file-typed outputs to UserFile objects
   */
  static async processToolOutputs(
    toolOutput: any,
    toolConfig: ToolConfig,
    executionContext: ExecutionContext
  ): Promise<any> {
    if (!toolConfig.outputs) {
      return toolOutput
    }

    const processedOutput = { ...toolOutput }

    // Process each output that's marked as file or file[]
    for (const [outputKey, outputDef] of Object.entries(toolConfig.outputs)) {
      if (!FileToolProcessor.isFileOutput(outputDef.type)) {
        continue
      }

      const fileData = processedOutput[outputKey]
      if (!fileData) {
        logger.warn(`File-typed output '${outputKey}' is missing from tool result`)
        continue
      }

      try {
        processedOutput[outputKey] = await FileToolProcessor.processFileOutput(
          fileData,
          outputDef.type,
          outputKey,
          executionContext
        )
      } catch (error) {
        logger.error(`Error processing file output '${outputKey}':`, error)
        const errorMessage = error instanceof Error ? error.message : String(error)
        throw new Error(`Failed to process file output '${outputKey}': ${errorMessage}`)
      }
    }

    return processedOutput
  }

  /**
   * Check if an output type is file-related
   */
  private static isFileOutput(type: string): boolean {
    return type === 'file' || type === 'file[]'
  }

  /**
   * Process a single file output (either single file or array of files)
   */
  private static async processFileOutput(
    fileData: any,
    outputType: string,
    outputKey: string,
    executionContext: ExecutionContext
  ): Promise<UserFile | UserFile[]> {
    if (outputType === 'file[]') {
      return FileToolProcessor.processFileArray(fileData, outputKey, executionContext)
    }
    return FileToolProcessor.processFileData(fileData, executionContext, outputKey)
  }

  /**
   * Process an array of files
   */
  private static async processFileArray(
    fileData: any,
    outputKey: string,
    executionContext: ExecutionContext
  ): Promise<UserFile[]> {
    if (!Array.isArray(fileData)) {
      throw new Error(`Output '${outputKey}' is marked as file[] but is not an array`)
    }

    return Promise.all(
      fileData.map((file, index) =>
        FileToolProcessor.processFileData(file, executionContext, `${outputKey}[${index}]`)
      )
    )
  }

  /**
   * Check if the data is already a UserFile object
   */
  private static isUserFile(data: any): data is UserFile {
    return (
      data &&
      typeof data === 'object' &&
      'id' in data &&
      'key' in data &&
      'uploadedAt' in data &&
      'expiresAt' in data &&
      typeof data.id === 'string' &&
      typeof data.key === 'string'
    )
  }

  /**
   * Convert various file data formats to UserFile by storing in execution filesystem
   */
  private static async processFileData(
    fileData: ToolFileData,
    context: ExecutionContext,
    outputKey: string
  ): Promise<UserFile> {
    // If the data is already a UserFile (from previous processing), return it as-is
    if (FileToolProcessor.isUserFile(fileData)) {
      logger.info(
        `Output '${outputKey}' is already a UserFile (${fileData.name}), skipping processing`
      )
      return fileData
    }

    logger.info(`Processing file data for output '${outputKey}': ${fileData.name}`)
    try {
      let buffer: Buffer

      if (Buffer.isBuffer(fileData.data)) {
        buffer = fileData.data
        logger.info(`Using Buffer data for ${fileData.name} (${buffer.length} bytes)`)
      } else if (
        fileData.data &&
        typeof fileData.data === 'object' &&
        'type' in fileData.data &&
        'data' in fileData.data
      ) {
        const serializedBuffer = fileData.data as { type: string; data: number[] }
        if (serializedBuffer.type === 'Buffer' && Array.isArray(serializedBuffer.data)) {
          buffer = Buffer.from(serializedBuffer.data)
        } else {
          throw new Error(`Invalid serialized buffer format for ${fileData.name}`)
        }
        logger.info(
          `Converted serialized Buffer to Buffer for ${fileData.name} (${buffer.length} bytes)`
        )
      } else if (typeof fileData.data === 'string' && fileData.data) {
        let base64Data = fileData.data

        if (base64Data && (base64Data.includes('-') || base64Data.includes('_'))) {
          base64Data = base64Data.replace(/-/g, '+').replace(/_/g, '/')
        }

        buffer = Buffer.from(base64Data, 'base64')
        logger.info(
          `Converted base64 string to Buffer for ${fileData.name} (${buffer.length} bytes)`
        )
      } else if (fileData.url) {
        logger.info(`Downloading file from URL: ${fileData.url}`)

        // Use server-side download helper that handles both internal and external URLs
        const { downloadFileFromUrl } = await import('@/lib/uploads/utils/file-utils.server')
        buffer = await downloadFileFromUrl(fileData.url)

        logger.info(`Downloaded file from URL for ${fileData.name} (${buffer.length} bytes)`)
      } else {
        throw new Error(
          `File data for '${fileData.name}' must have either 'data' (Buffer/base64) or 'url' property`
        )
      }

      if (buffer.length === 0) {
        throw new Error(`File '${fileData.name}' has zero bytes`)
      }

      // Upload file and get internal metadata with storage key
      const internalMetadata = await uploadExecutionFile(
        {
          workspaceId: context.workspaceId || '',
          workflowId: context.workflowId,
          executionId: context.executionId || '',
          userId: context.userId,
        },
        buffer,
        fileData.name,
        fileData.mimeType
      )

      logger.info(
        `Successfully stored file '${fileData.name}' in execution filesystem with key: ${internalMetadata.key}`
      )

      // Convert to public UserFile type (strips internal key and context fields)
      const userFile = toUserFile(internalMetadata)
      return userFile
    } catch (error) {
      logger.error(`Error processing file data for '${fileData.name}':`, error)
      throw error
    }
  }

  /**
   * Check if a tool has any file-typed outputs
   */
  static hasFileOutputs(toolConfig: ToolConfig): boolean {
    if (!toolConfig.outputs) {
      return false
    }

    return Object.values(toolConfig.outputs).some(
      (output) => output.type === 'file' || output.type === 'file[]'
    )
  }
}
