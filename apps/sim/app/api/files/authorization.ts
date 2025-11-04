import { db } from '@sim/db'
import { workspaceFile } from '@sim/db/schema'
import { eq } from 'drizzle-orm'
import { createLogger } from '@/lib/logs/console/logger'
import { getUserEntityPermissions } from '@/lib/permissions/utils'
import type { StorageContext } from '@/lib/uploads/config'
import { getFileMetadataByKey } from '@/lib/uploads/server/metadata'
import { inferContextFromKey } from '@/lib/uploads/utils/file-utils'

const logger = createLogger('FileAuthorization')

export interface AuthorizationResult {
  granted: boolean
  reason: string
  workspaceId?: string
}

/**
 * Single source of truth for all file access control.
 *
 * Authorization rules:
 * - execution/workspace/knowledge-base/copilot: Workspace membership required
 * - profile-pictures: User ownership required
 * - Legacy files: Check both new and old database tables
 */
export async function authorizeFileAccess(
  key: string,
  userId: string,
  context?: StorageContext
): Promise<AuthorizationResult> {
  try {
    const fileContext = context || inferContextFromKey(key)

    const fileRecord = await getFileMetadataByKey(key, fileContext)

    if (fileRecord) {
      if (fileContext === 'profile-pictures') {
        const granted = fileRecord.userId === userId
        return {
          granted,
          reason: granted ? 'User owns file' : 'User does not own file',
        }
      }

      if (fileRecord.workspaceId) {
        const permission = await getUserEntityPermissions(
          userId,
          'workspace',
          fileRecord.workspaceId
        )
        const granted = permission !== null

        return {
          granted,
          reason: granted ? 'User has workspace access' : 'User lacks workspace access',
          workspaceId: fileRecord.workspaceId,
        }
      }
    }

    // Priority 2: Check legacy workspace_file table (backward compatibility)
    // Only for workspace files that may not have been migrated yet
    if (fileContext === 'workspace' || !fileContext) {
      const legacyFile = await lookupLegacyWorkspaceFile(key)

      if (legacyFile) {
        const permission = await getUserEntityPermissions(
          userId,
          'workspace',
          legacyFile.workspaceId
        )
        const granted = permission !== null

        return {
          granted,
          reason: granted
            ? 'User has workspace access (legacy table)'
            : 'User lacks workspace access (legacy table)',
          workspaceId: legacyFile.workspaceId,
        }
      }
    }

    // Priority 3: Execution files - extract workspaceId from key pattern
    // Format: {workspaceId}/{workflowId}/{executionId}/{filename}
    if (fileContext === 'execution') {
      const parts = key.split('/')
      if (parts.length >= 3) {
        const workspaceId = parts[0]
        if (workspaceId && /^[a-f0-9-]{36}$/.test(workspaceId)) {
          const permission = await getUserEntityPermissions(userId, 'workspace', workspaceId)
          const granted = permission !== null

          return {
            granted,
            reason: granted
              ? 'User has workspace access (path-based)'
              : 'User lacks workspace access (path-based)',
            workspaceId,
          }
        }
      }
    }

    // No authorization metadata found
    return {
      granted: false,
      reason: 'File not found or missing authorization metadata',
    }
  } catch (error) {
    logger.error('Error in unified file authorization', { key, userId, error })
    return {
      granted: false,
      reason: 'Authorization check failed',
    }
  }
}

/**
 * Lookup file in legacy workspace_file table
 * Used for backward compatibility during migration period
 */
async function lookupLegacyWorkspaceFile(
  key: string
): Promise<{ workspaceId: string; uploadedBy: string } | null> {
  try {
    const [legacyFile] = await db
      .select({
        workspaceId: workspaceFile.workspaceId,
        uploadedBy: workspaceFile.uploadedBy,
      })
      .from(workspaceFile)
      .where(eq(workspaceFile.key, key))
      .limit(1)

    return legacyFile || null
  } catch (error) {
    // Ignore errors (table may not exist after migration)
    logger.debug('Legacy table check failed (may not exist)', { key, error })
    return null
  }
}

/**
 * Verify file access - Simplified wrapper around unified authorization
 * Maintains backward compatibility with existing call sites
 *
 * @param cloudKey The file key/path
 * @param userId The authenticated user ID
 * @param bucketType Optional bucket type (legacy parameter, ignored)
 * @param customConfig Optional custom storage configuration (legacy parameter, ignored)
 * @param context Optional explicit storage context
 * @param isLocal Optional flag indicating if this is local storage (legacy parameter, ignored)
 * @returns Promise<boolean> True if user has access, false otherwise
 */
export async function verifyFileAccess(
  cloudKey: string,
  userId: string,
  context?: StorageContext
): Promise<boolean> {
  const result = await authorizeFileAccess(cloudKey, userId, context)
  return result.granted
}
