import useWaitForI18n from '@/shared/hooks/use-wait-for-i18n'
import { Trans, useTranslation } from 'react-i18next'
import withErrorBoundary from '@/infrastructure/error-boundary'
import { GenericErrorBoundaryFallback } from '@/shared/components/generic-error-boundary-fallback'
import { useCallback } from 'react'
import getMeta from '@/utils/meta'
import { postJSON } from '@/infrastructure/fetch-json'
import { debugConsole } from '@/utils/debugging'
import useAsync from '@/shared/hooks/use-async'
import Notification from '@/shared/components/notification'

function SharingUpdatesRoot() {
  const { isReady } = useWaitForI18n()
  const { t } = useTranslation()
  const { isLoading, isSuccess, isError, runAsync } = useAsync()
  const projectId = getMeta('ol-project_id')

  const joinProject = useCallback(() => {
    runAsync(postJSON(`/project/${projectId}/sharing-updates/join`))
      .then(() => {
        location.assign(`/project/${projectId}`)
      })
      .catch(debugConsole.error)
  }, [runAsync, projectId])

  const viewProject = useCallback(() => {
    runAsync(postJSON(`/project/${projectId}/sharing-updates/view`))
      .then(() => {
        location.assign(`/project/${projectId}`)
      })
      .catch(debugConsole.error)
  }, [runAsync, projectId])

  const leaveProject = useCallback(() => {
    runAsync(postJSON(`/project/${projectId}/leave`))
      .then(() => {
        location.assign('/project')
      })
      .catch(debugConsole.error)
  }, [runAsync, projectId])

  if (!isReady) {
    return null
  }

  return (
    <div className="container">
      <div className="row">
        <div className="col-md-6 col-md-offset-3">
          <div className="card sharing-updates">
            <div className="row">
              <div className="col-md-12">
                <h1 className="sharing-updates-h1">
                  {t('updates_to_project_sharing')}
                </h1>
              </div>
            </div>

            <div className="row row-spaced">
              <div className="col-md-12">
                <p>
                  <Trans
                    i18nKey="were_making_some_changes_to_project_sharing_this_means_you_will_be_visible"
                    components={[
                      // eslint-disable-next-line jsx-a11y/anchor-has-content, react/jsx-key
                      <a
                        href="/blog/changes-to-project-sharing"
                        rel="noopener noreferrer"
                        target="_blank"
                      />,
                    ]}
                  />
                </p>
              </div>
            </div>

            <div className="row row-spaced">
              <div className="col-md-12">
                <button
                  className="btn btn-primary"
                  onClick={() => joinProject()}
                  disabled={isLoading}
                >
                  {t('ok_continue_to_project')}
                </button>
              </div>
            </div>

            {isError && (
              <div className="row row-spaced">
                <div className="col-md-12">
                  <Notification
                    type="error"
                    content={t('generic_something_went_wrong')}
                  />
                </div>
              </div>
            )}

            <div className="row row-spaced">
              <div className="col-md-12">
                <p>
                  <small>
                    <Trans
                      i18nKey="you_can_also_choose_to_view_anonymously_or_leave_the_project"
                      components={[
                        // eslint-disable-next-line react/jsx-key
                        <button
                          className="btn btn-inline-link"
                          onClick={() => viewProject()}
                          disabled={isLoading || isSuccess}
                        />,
                        // eslint-disable-next-line react/jsx-key
                        <button
                          className="btn btn-inline-link"
                          onClick={() => leaveProject()}
                          disabled={isLoading || isSuccess}
                        />,
                      ]}
                    />
                  </small>
                </p>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}

export default withErrorBoundary(
  SharingUpdatesRoot,
  GenericErrorBoundaryFallback
)
