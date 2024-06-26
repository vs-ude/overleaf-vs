const AuthenticationController = require('../Authentication/AuthenticationController')
const SessionManager = require('../Authentication/SessionManager')
const TokenAccessHandler = require('./TokenAccessHandler')
const Errors = require('../Errors/Errors')
const logger = require('@overleaf/logger')
const settings = require('@overleaf/settings')
const OError = require('@overleaf/o-error')
const { expressify } = require('@overleaf/promise-utils')
const AuthorizationManager = require('../Authorization/AuthorizationManager')
const PrivilegeLevels = require('../Authorization/PrivilegeLevels')
const {
  handleAdminDomainRedirect,
} = require('../Authorization/AuthorizationMiddleware')
const ProjectAuditLogHandler = require('../Project/ProjectAuditLogHandler')
const SplitTestHandler = require('../SplitTests/SplitTestHandler')
const CollaboratorsHandler = require('../Collaborators/CollaboratorsHandler')
const EditorRealTimeController = require('../Editor/EditorRealTimeController')
const CollaboratorsGetter = require('../Collaborators/CollaboratorsGetter')
const ProjectGetter = require('../Project/ProjectGetter')
const AsyncFormHelper = require('../Helpers/AsyncFormHelper')

const orderedPrivilegeLevels = [
  PrivilegeLevels.NONE,
  PrivilegeLevels.READ_ONLY,
  PrivilegeLevels.READ_AND_WRITE,
  PrivilegeLevels.OWNER,
]

async function _userAlreadyHasHigherPrivilege(userId, projectId, tokenType) {
  if (!Object.values(TokenAccessHandler.TOKEN_TYPES).includes(tokenType)) {
    throw new Error('bad token type')
  }
  if (!userId) {
    return false
  }
  const privilegeLevel =
    await AuthorizationManager.promises.getPrivilegeLevelForProject(
      userId,
      projectId
    )
  return (
    orderedPrivilegeLevels.indexOf(privilegeLevel) >=
    orderedPrivilegeLevels.indexOf(tokenType)
  )
}

const makePostUrl = token => {
  if (TokenAccessHandler.isReadAndWriteToken(token)) {
    return `/${token}/grant`
  } else if (TokenAccessHandler.isReadOnlyToken(token)) {
    return `/read/${token}/grant`
  } else {
    throw new Error('invalid token type')
  }
}

async function _handleV1Project(token, userId) {
  if (!userId) {
    return { v1Import: { status: 'mustLogin' } }
  } else {
    const docInfo = await TokenAccessHandler.promises.getV1DocInfo(
      token,
      userId
    )
    // This should not happen anymore, but it does show
    // a nice "contact support" message, so it can stay
    if (!docInfo) {
      return { v1Import: { status: 'cannotImport' } }
    }
    if (!docInfo.exists) {
      return null
    }
    if (docInfo.exported) {
      return null
    }
    return {
      v1Import: {
        status: 'canDownloadZip',
        projectId: token,
        hasOwner: docInfo.has_owner,
        name: docInfo.name || 'Untitled',
        brandInfo: docInfo.brand_info,
      },
    }
  }
}

async function tokenAccessPage(req, res, next) {
  const { token } = req.params
  if (!TokenAccessHandler.isValidToken(token)) {
    return next(new Errors.NotFoundError())
  }
  if (handleAdminDomainRedirect(req, res)) {
    // Admin users do not join the project, but view it on the admin domain.
    return
  }
  try {
    if (TokenAccessHandler.isReadOnlyToken(token)) {
      const docPublishedInfo =
        await TokenAccessHandler.promises.getV1DocPublishedInfo(token)
      if (docPublishedInfo.allow === false) {
        return res.redirect(302, docPublishedInfo.published_path)
      }
    }

    res.render('project/token/access-react', {
      postUrl: makePostUrl(token),
    })
  } catch (err) {
    return next(
      OError.tag(err, 'error while rendering token access page', { token })
    )
  }
}

async function checkAndGetProjectOrResponseAction(
  tokenType,
  token,
  userId,
  tokenHashPrefix,
  req,
  res,
  next
) {
  const isAnonymousUser = !userId
  if (
    isAnonymousUser &&
    tokenType === TokenAccessHandler.TOKEN_TYPES.READ_AND_WRITE &&
    !TokenAccessHandler.ANONYMOUS_READ_AND_WRITE_ENABLED
  ) {
    logger.warn('[TokenAccess] deny anonymous read-and-write token access')

    let projectUrlWithToken = TokenAccessHandler.makeTokenUrl(token)

    if (tokenHashPrefix && tokenHashPrefix.startsWith('#')) {
      projectUrlWithToken += `${tokenHashPrefix}`
    }

    AuthenticationController.setRedirectInSession(req, projectUrlWithToken)
    return [
      null,
      () => {
        res.json({
          redirect: '/restricted',
          anonWriteAccessDenied: true,
        })
      },
      { action: 'denied anonymous read-and-write token access' },
    ]
  }

  // Try to get the project, and/or an alternative action to take.
  // Returns a tuple of [project, action]
  const project = await TokenAccessHandler.promises.getProjectByToken(
    tokenType,
    token
  )
  if (!project) {
    if (settings.overleaf) {
      const v1ImportData = await _handleV1Project(token, userId)
      return [
        null,
        () => {
          if (v1ImportData) {
            res.json(v1ImportData)
          } else {
            res.sendStatus(404)
          }
        },
        { action: v1ImportData ? 'import v1' : '404' },
      ]
    } else {
      return [null, null, { action: '404' }]
    }
  }

  const projectId = project._id

  const tokenAccessEnabled =
    TokenAccessHandler.tokenAccessEnabledForProject(project)
  if (isAnonymousUser && tokenAccessEnabled) {
    if (tokenType === TokenAccessHandler.TOKEN_TYPES.READ_AND_WRITE) {
      if (TokenAccessHandler.ANONYMOUS_READ_AND_WRITE_ENABLED) {
        logger.debug({ projectId }, 'granting read-write anonymous access')
        TokenAccessHandler.grantSessionTokenAccess(req, projectId, token)
        return [
          null,
          () => {
            res.json({
              redirect: `/project/${projectId}`,
              grantAnonymousAccess: tokenType,
            })
          },
          { projectId, action: 'granting read-write anonymous access' },
        ]
      } else {
        // anonymous read-and-write token access should have been denied already
        throw new Error(
          'unreachable: anonymous read-and-write token access bug'
        )
      }
    } else if (tokenType === TokenAccessHandler.TOKEN_TYPES.READ_ONLY) {
      logger.debug({ projectId }, 'granting read-only anonymous access')
      TokenAccessHandler.grantSessionTokenAccess(req, projectId, token)
      return [
        null,
        () => {
          res.json({
            redirect: `/project/${projectId}`,
            grantAnonymousAccess: tokenType,
          })
        },
        { projectId, action: 'granting read-only anonymous access' },
      ]
    } else {
      throw new Error('unreachable')
    }
  }
  const userHasPrivilege = await _userAlreadyHasHigherPrivilege(
    userId,
    projectId,
    tokenType
  )
  if (userHasPrivilege) {
    return [
      null,
      () => {
        res.json({ redirect: `/project/${project._id}`, higherAccess: true })
      },
      { projectId, action: 'user already has higher or same privilege' },
    ]
  }
  if (!tokenAccessEnabled) {
    return [
      null,
      () => {
        next(new Errors.NotFoundError())
      },
      { projectId, action: 'token access not enabled' },
    ]
  }
  return [project, null, { projectId, action: 'continue' }]
}

async function grantTokenAccessReadAndWrite(req, res, next) {
  const { token } = req.params
  const { confirmedByUser, tokenHashPrefix } = req.body
  const userId = SessionManager.getLoggedInUserId(req.session)
  if (!TokenAccessHandler.isReadAndWriteToken(token)) {
    return res.sendStatus(400)
  }
  const tokenType = TokenAccessHandler.TOKEN_TYPES.READ_AND_WRITE

  try {
    const [project, action, logData] = await checkAndGetProjectOrResponseAction(
      tokenType,
      token,
      userId,
      tokenHashPrefix,
      req,
      res,
      next
    )

    TokenAccessHandler.checkTokenHashPrefix(
      token,
      tokenHashPrefix,
      tokenType,
      userId,
      logData
    )

    if (action) {
      return action()
    }
    if (!project) {
      return next(new Errors.NotFoundError())
    }

    const linkSharingChanges =
      await SplitTestHandler.promises.getAssignmentForUser(
        project.owner_ref,
        'link-sharing-warning'
      )

    if (linkSharingChanges?.variant === 'active') {
      if (!confirmedByUser) {
        return res.json({
          requireAccept: {
            linkSharingChanges: true,
            projectName: project.name,
          },
        })
      }

      await ProjectAuditLogHandler.promises.addEntry(
        project._id,
        'accept-via-link-sharing',
        userId,
        req.ip,
        { privileges: 'readAndWrite' }
      )
      // Currently does not enforce the collaborator limit (warning phase)
      await CollaboratorsHandler.promises.addUserIdToProject(
        project._id,
        undefined,
        userId,
        PrivilegeLevels.READ_AND_WRITE
      )
      // Does not remove any pending invite or the invite notification
      // Should be a noop if the user is already a member,
      // and would redirect transparently into the project.
      EditorRealTimeController.emitToRoom(
        project._id,
        'project:membership:changed',
        { members: true }
      )

      return res.json({
        redirect: `/project/${project._id}`,
      })
    } else {
      if (!confirmedByUser) {
        return res.json({
          requireAccept: {
            projectName: project.name,
          },
        })
      }

      if (!project.tokenAccessReadAndWrite_refs.some(id => id.equals(userId))) {
        await ProjectAuditLogHandler.promises.addEntry(
          project._id,
          'join-via-token',
          userId,
          req.ip,
          { privileges: 'readAndWrite' }
        )
      }

      await TokenAccessHandler.promises.addReadAndWriteUserToProject(
        userId,
        project._id
      )

      return res.json({
        redirect: `/project/${project._id}`,
        tokenAccessGranted: tokenType,
      })
    }
  } catch (err) {
    return next(
      OError.tag(
        err,
        'error while trying to grant read-and-write token access',
        { token }
      )
    )
  }
}

async function grantTokenAccessReadOnly(req, res, next) {
  const { token } = req.params
  const { confirmedByUser, tokenHashPrefix } = req.body
  const userId = SessionManager.getLoggedInUserId(req.session)
  if (!TokenAccessHandler.isReadOnlyToken(token)) {
    return res.sendStatus(400)
  }

  const tokenType = TokenAccessHandler.TOKEN_TYPES.READ_ONLY

  const docPublishedInfo =
    await TokenAccessHandler.promises.getV1DocPublishedInfo(token)
  if (docPublishedInfo.allow === false) {
    return res.json({ redirect: docPublishedInfo.published_path })
  }
  try {
    const [project, action, logData] = await checkAndGetProjectOrResponseAction(
      tokenType,
      token,
      userId,
      tokenHashPrefix,
      req,
      res,
      next
    )

    TokenAccessHandler.checkTokenHashPrefix(
      token,
      tokenHashPrefix,
      tokenType,
      userId,
      logData
    )

    if (action) {
      return action()
    }
    if (!project) {
      return next(new Errors.NotFoundError())
    }

    if (!confirmedByUser) {
      return res.json({
        requireAccept: {
          projectName: project.name,
        },
      })
    }

    if (!project.tokenAccessReadOnly_refs.some(id => id.equals(userId))) {
      await ProjectAuditLogHandler.promises.addEntry(
        project._id,
        'join-via-token',
        userId,
        req.ip,
        { privileges: 'readOnly' }
      )
    }

    await TokenAccessHandler.promises.addReadOnlyUserToProject(
      userId,
      project._id
    )

    return res.json({
      redirect: `/project/${project._id}`,
      tokenAccessGranted: tokenType,
    })
  } catch (err) {
    return next(
      OError.tag(err, 'error while trying to grant read-only token access', {
        token,
      })
    )
  }
}

async function ensureUserCanUseSharingUpdatesConsentPage(req, res, next) {
  const { Project_id: projectId } = req.params
  const userId = SessionManager.getLoggedInUserId(req.session)
  const project = await ProjectGetter.promises.getProject(projectId, {
    owner_ref: 1,
  })
  if (!project) {
    throw new Errors.NotFoundError()
  }
  const linkSharingChanges =
    await SplitTestHandler.promises.getAssignmentForUser(
      project.owner_ref,
      'link-sharing-warning'
    )
  if (linkSharingChanges?.variant !== 'active') {
    return AsyncFormHelper.redirect(req, res, `/project/${projectId}`)
  }
  const isReadWriteTokenMember =
    await CollaboratorsGetter.promises.userIsReadWriteTokenMember(
      userId,
      projectId
    )
  if (!isReadWriteTokenMember) {
    // If the user is not a read write token member, there are no actions to take
    return AsyncFormHelper.redirect(req, res, `/project/${projectId}`)
  }
  const isReadWriteMember =
    await CollaboratorsGetter.promises.isUserInvitedReadWriteMemberOfProject(
      userId,
      projectId
    )
  if (isReadWriteMember) {
    // If the user is already an invited editor, the actions don't make sense
    return AsyncFormHelper.redirect(req, res, `/project/${projectId}`)
  }
  next()
}

async function sharingUpdatesConsent(req, res, next) {
  const { Project_id: projectId } = req.params
  res.render('project/token/sharing-updates', {
    projectId,
  })
}

async function moveReadWriteToCollaborators(req, res, next) {
  const { Project_id: projectId } = req.params
  const userId = SessionManager.getLoggedInUserId(req.session)
  const isInvitedMember =
    await CollaboratorsGetter.promises.isUserInvitedMemberOfProject(
      userId,
      projectId
    )
  await ProjectAuditLogHandler.promises.addEntry(
    projectId,
    'accept-via-link-sharing',
    userId,
    req.ip,
    {
      privileges: 'readAndWrite',
      tokenMember: true,
      invitedMember: isInvitedMember,
    }
  )
  if (isInvitedMember) {
    // Read only invited viewer who is gaining edit access via link sharing
    await TokenAccessHandler.promises.removeReadAndWriteUserFromProject(
      userId,
      projectId
    )
    await CollaboratorsHandler.promises.setCollaboratorPrivilegeLevel(
      projectId,
      userId,
      PrivilegeLevels.READ_AND_WRITE
    )
  } else {
    // Normal case, not invited, joining via link sharing
    await TokenAccessHandler.promises.removeReadAndWriteUserFromProject(
      userId,
      projectId
    )
    await CollaboratorsHandler.promises.addUserIdToProject(
      projectId,
      undefined,
      userId,
      PrivilegeLevels.READ_AND_WRITE
    )
  }
  EditorRealTimeController.emitToRoom(projectId, 'project:membership:changed', {
    members: true,
  })
  res.sendStatus(204)
}

async function moveReadWriteToReadOnly(req, res, next) {
  const { Project_id: projectId } = req.params
  const userId = SessionManager.getLoggedInUserId(req.session)
  await ProjectAuditLogHandler.promises.addEntry(
    projectId,
    'readonly-via-sharing-updates',
    userId,
    req.ip
  )
  await TokenAccessHandler.promises.moveReadAndWriteUserToReadOnly(
    userId,
    projectId
  )
  res.sendStatus(204)
}

module.exports = {
  READ_ONLY_TOKEN_PATTERN: TokenAccessHandler.READ_ONLY_TOKEN_PATTERN,
  READ_AND_WRITE_TOKEN_PATTERN: TokenAccessHandler.READ_AND_WRITE_TOKEN_PATTERN,

  tokenAccessPage: expressify(tokenAccessPage),
  grantTokenAccessReadOnly: expressify(grantTokenAccessReadOnly),
  grantTokenAccessReadAndWrite: expressify(grantTokenAccessReadAndWrite),
  ensureUserCanUseSharingUpdatesConsentPage: expressify(
    ensureUserCanUseSharingUpdatesConsentPage
  ),
  sharingUpdatesConsent: expressify(sharingUpdatesConsent),
  moveReadWriteToCollaborators: expressify(moveReadWriteToCollaborators),
  moveReadWriteToReadOnly: expressify(moveReadWriteToReadOnly),
}
