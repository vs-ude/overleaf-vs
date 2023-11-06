import React, {
  createContext,
  useContext,
  useState,
  FC,
  useMemo,
  useEffect,
  useCallback,
} from 'react'
import { ReactScopeValueStore } from '@/features/ide-react/scope-value-store/react-scope-value-store'
import populateLayoutScope from '@/features/ide-react/scope-adapters/layout-context-adapter'
import populateReviewPanelScope from '@/features/ide-react/scope-adapters/review-panel-context-adapter'
import { IdeProvider } from '@/shared/context/ide-context'
import {
  createIdeEventEmitter,
  IdeEventEmitter,
} from '@/features/ide-react/create-ide-event-emitter'
import { JoinProjectPayload } from '@/features/ide-react/connection/join-project-payload'
import { useConnectionContext } from '@/features/ide-react/context/connection-context'
import { getMockIde } from '@/shared/context/mock/mock-ide'
import { populateEditorScope } from '@/features/ide-react/context/editor-manager-context'
import { postJSON } from '@/infrastructure/fetch-json'
import { EventLog } from '@/features/ide-react/editor/event-log'
import { populateSettingsScope } from '@/features/ide-react/scope-adapters/settings-adapter'
import { populateOnlineUsersScope } from '@/features/ide-react/context/online-users-context'
import { populateReferenceScope } from '@/features/ide-react/context/references-context'
import { ReactScopeEventEmitter } from '@/features/ide-react/scope-event-emitter/react-scope-event-emitter'
import getMeta from '@/utils/meta'

type IdeReactContextValue = {
  projectId: string
  eventEmitter: IdeEventEmitter
  eventLog: EventLog
  startedFreeTrial: boolean
  setStartedFreeTrial: React.Dispatch<
    React.SetStateAction<IdeReactContextValue['startedFreeTrial']>
  >
  reportError: (error: any, meta?: Record<string, any>) => void
}

const IdeReactContext = createContext<IdeReactContextValue | undefined>(
  undefined
)

function populateIdeReactScope(store: ReactScopeValueStore) {
  store.set('sync_tex_error', false)
}

function populateProjectScope(store: ReactScopeValueStore) {
  store.allowNonExistentPath('project', true)
  store.set('permissionsLevel', 'readOnly')
}

function populatePdfScope(store: ReactScopeValueStore) {
  store.allowNonExistentPath('pdf', true)
}

function populateFileTreeScope(store: ReactScopeValueStore) {
  store.set('docs', [])
}

function createReactScopeValueStore(projectId: string) {
  const scopeStore = new ReactScopeValueStore()

  // Populate the scope value store with default values that will be used by
  // nested contexts that refer to scope values. The ideal would be to leave
  // initialization of store values up to the nested context, which would keep
  // initialization code together with the context and would only populate
  // necessary values in the store, but this is simpler for now
  populateIdeReactScope(scopeStore)
  populateEditorScope(scopeStore, projectId)
  populateLayoutScope(scopeStore)
  populateProjectScope(scopeStore)
  populatePdfScope(scopeStore)
  populateSettingsScope(scopeStore)
  populateOnlineUsersScope(scopeStore)
  populateReferenceScope(scopeStore)
  populateFileTreeScope(scopeStore)
  populateReviewPanelScope(scopeStore)

  scopeStore.allowNonExistentPath('hasLintingError')
  scopeStore.allowNonExistentPath('loadingThreads')

  return scopeStore
}

const projectId = window.project_id

export const IdeReactProvider: FC = ({ children }) => {
  const [scopeStore] = useState(() => createReactScopeValueStore(projectId))
  const [eventEmitter] = useState(createIdeEventEmitter)
  const [scopeEventEmitter] = useState(
    () => new ReactScopeEventEmitter(eventEmitter)
  )
  const [eventLog] = useState(() => new EventLog())
  const [startedFreeTrial, setStartedFreeTrial] = useState(false)

  const { socket } = useConnectionContext()

  const reportError = useCallback(
    (error: any, meta?: Record<string, any>) => {
      const metadata = {
        ...meta,
        user_id: getMeta('ol-user_id'),
        project_id: projectId,
        // @ts-ignore
        client_id: socket.socket?.sessionid,
        // @ts-ignore
        transport: socket.socket?.transport?.name,
        client_now: new Date(),
      }

      const errorObj: Record<string, any> = {}
      if (typeof error === 'object') {
        for (const key of Object.getOwnPropertyNames(error)) {
          errorObj[key] = error[key]
        }
      } else if (typeof error === 'string') {
        errorObj.message = error
      }
      return postJSON('/error/client', {
        body: {
          error: errorObj,
          meta: metadata,
          _csrf: window.csrfToken,
        },
      })
    },
    [socket.socket]
  )

  // Populate scope values when joining project, then fire project:joined event
  useEffect(() => {
    function handleJoinProjectResponse({
      project,
      permissionsLevel,
    }: JoinProjectPayload) {
      scopeStore.set('project', { rootDoc_id: null, ...project })
      scopeStore.set('permissionsLevel', permissionsLevel)
      // Make watchers update immediately
      scopeStore.flushUpdates()
      eventEmitter.emit('project:joined', { project, permissionsLevel })
    }

    socket.on('joinProjectResponse', handleJoinProjectResponse)

    return () => {
      socket.removeListener('joinProjectResponse', handleJoinProjectResponse)
    }
  }, [socket, eventEmitter, scopeStore])

  const ide = useMemo(() => {
    return {
      ...getMockIde(),
      socket,
      reportError,
      // TODO: MIGRATION: Remove this once it's no longer used
      fileTreeManager: {
        findEntityByPath: () => null,
        selectEntity: () => {},
        getPreviewByPath: () => null,
        getRootDocDirname: () => '',
      },
    }
  }, [socket, reportError])

  const value = useMemo(
    () => ({
      eventEmitter,
      eventLog,
      startedFreeTrial,
      setStartedFreeTrial,
      projectId,
      reportError,
    }),
    [eventEmitter, eventLog, reportError, startedFreeTrial]
  )

  return (
    <IdeReactContext.Provider value={value}>
      <IdeProvider
        ide={ide}
        scopeStore={scopeStore}
        scopeEventEmitter={scopeEventEmitter}
      >
        {children}
      </IdeProvider>
    </IdeReactContext.Provider>
  )
}

export function useIdeReactContext(): IdeReactContextValue {
  const context = useContext(IdeReactContext)

  if (!context) {
    throw new Error(
      'useIdeReactContext is only available inside IdeReactProvider'
    )
  }

  return context
}