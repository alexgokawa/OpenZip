import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  AlertCircle,
  ArrowLeft,
  ArrowRight,
  ArrowUp,
  CheckCircle2,
  ChevronRight,
  Download,
  File as FileIcon,
  FileArchive,
  FileOutput,
  FileText,
  Folder,
  FolderOpen,
  HardDrive,
  Image as ImageIcon,
  Info,
  Loader2,
  PackageOpen,
  RotateCcw,
  RotateCw,
  Save,
  Upload,
  X,
} from 'lucide-react'
import './App.css'

const EditorPane = lazy(() => import('./EditorPane'))

/* ------------------------------------------------------------------ */
/* Types shared with the Electron main process                         */
/* ------------------------------------------------------------------ */

type ArchiveFormat = string
type EntryKind = 'file' | 'directory' | 'container'
type SortKey = 'name' | 'size' | 'packed' | 'time'
type SortDir = 1 | -1
type BusyState = 'reading' | 'adding' | 'extracting' | 'writing' | 'nested' | null
type Tone = 'info' | 'success' | 'error'

interface ArchiveEntry {
  name: string
  size: number
  compressedSize: number | null
  isDirectory: boolean
  time: number | null
  kind: EntryKind
  encrypted: boolean
}

interface ArchiveStats {
  fileCount: number
  folderCount: number
  totalSize: number
  totalPackedSize: number
}

interface ArchiveInfo {
  filePath: string
  fileName: string
  fileSize: number
  format: ArchiveFormat
  entries: ArchiveEntry[]
  stats: ArchiveStats
  note: string | null
}

interface OpenResult {
  canceled: boolean
  filePath: string | null
}

interface ReadResult {
  ok: boolean
  error?: string
  filePath?: string
  fileName?: string
  fileSize?: number
  format?: ArchiveFormat
  entries?: ArchiveEntry[]
  stats?: ArchiveStats
  note?: string | null
}

interface ExtractResult {
  ok: boolean
  error?: string
  format?: string
  outputDir?: string
  extracted?: number
  total?: number | null
  message?: string
  log?: string[]
}

interface ReadFileResult {
  success: boolean
  content?: string
  error?: string
}

interface SaveFileResult {
  success: boolean
  error?: string
}

interface ChoosePathResult {
  canceled: boolean
  filePath: string | null
  error?: string
}

interface SaveScsModResult {
  success: boolean
  fileCount?: number
  path?: string
  error?: string
}

interface SaveScsCopyResult {
  success: boolean
  outputPath?: string
  size?: number
  edited?: string[]
  error?: string
}

interface EditingFile {
  name: string
  content: string
  isDirty: boolean
}

type NavigationType = 'folder' | 'editor' | 'image'

interface NavigationEntry {
  type: NavigationType
  path: string
  entryName?: string
}

interface NavigationState {
  history: NavigationEntry[]
  index: number
}

interface ArchiveFrame {
  archive: ArchiveInfo
  currentPath: string
  navigation: NavigationState
  dragSessionId: string | null
  scsEdits: Record<string, string>
  scsSavedEdits: Record<string, string>
  scsModPath: string | null
  selected: Set<string>
  nestedModified: boolean
  nestedInfo: NestedInfo | null
}

interface NestedInfo {
  outerArchivePath: string
  entryName: string
  filePath: string
  sessionId: string
}

interface OpenNestedResult {
  ok: boolean
  cached?: boolean
  needsConfirmation?: boolean
  entrySize?: number
  filePath?: string
  sessionId?: string
  entryName?: string
  outerArchivePath?: string
  outerSize?: number
  outerMtimeMs?: number
  error?: string
}

interface WriteBackResult {
  ok: boolean
  needsWarning?: boolean
  innerSize?: number
  solid?: boolean
  outerFormat?: string
  entryName?: string
  error?: string
}

interface DragPreparation {
  signature: string
  ready: boolean
}

interface PrepareDragResult {
  success: boolean
  ready?: boolean
  skipped?: boolean
  signature?: string
  items?: string[]
  tempDir?: string
  error?: string
}

interface ImagePreview {
  name: string
  dataUrl: string
}

interface ReadImageResult {
  success: boolean
  base64?: string
  error?: string
}

interface AddFilesResult {
  success: boolean
  added?: number
  error?: string
}

interface WebUtilsLike {
  getPathForFile: (file: File) => string
}

interface OpenExternalResult {
  success: boolean
  error?: string
}

const KOFI_URL = 'https://ko-fi.com/gokawa'
const GITHUB_URL = 'https://github.com/alexgokawa/OpenZip'
const SCS_MOD_STORE_PREFIX = 'openzip:scs-mod-target:'
const AUTO_DRAG_PREP_LIMIT_BYTES = 200 * 1024 * 1024
const NESTED_ARCHIVE_EXTENSIONS = new Set(['scs', 'zip', 'rar', '7z', 'tar', 'iso', 'cab'])
const NESTED_WRITABLE_FORMATS = new Set(['zip', '7z', 'tar'])
const NESTED_READ_ONLY_MESSAGE =
  'This archive is opened from inside another archive. Extract it to edit it.'
const NESTED_WRITEBACK_WARN_BYTES = 300 * 1024 * 1024

function isWritableArchiveFormat(format: string): boolean {
  return NESTED_WRITABLE_FORMATS.has(format)
}

function isNestedArchiveEntry(entryName: string): boolean {
  return NESTED_ARCHIVE_EXTENSIONS.has(fileExtension(entryName))
}

function selectionBytesFor(
  sizes: Map<string, number>,
  entries: string[],
): number {
  return entries.reduce((total, entry) => total + (sizes.get(entry) ?? 0), 0)
}

function hasTopLevelFolder(roots: string[]): boolean {
  return roots.some((root) => {
    if (!root.endsWith('/')) return false
    const name = root.slice(0, -1)
    return name.length > 0 && !name.includes('/')
  })
}

function readStoredScsModTarget(archivePath: string): string | null {
  try {
    return window.localStorage.getItem(`${SCS_MOD_STORE_PREFIX}${archivePath}`)
  } catch {
    return null
  }
}

function storeScsModTarget(archivePath: string, target: string): void {
  try {
    window.localStorage.setItem(`${SCS_MOD_STORE_PREFIX}${archivePath}`, target)
  } catch {
    /* storage unavailable */
  }
}

interface ProgressPayload {
  format: string
  phase: string
  done?: number | null
  total?: number | null
  percent?: number | null
  entry?: string
  message?: string
}

interface IpcRendererLike {
  invoke: (channel: string, ...args: unknown[]) => Promise<unknown>
  send: (channel: string, ...args: unknown[]) => void
  on: (channel: string, listener: (event: unknown, payload: unknown) => void) => void
  removeListener: (
    channel: string,
    listener: (event: unknown, payload: unknown) => void,
  ) => void
}

interface Row {
  key: string
  name: string
  type: 'folder' | 'file' | 'container'
  size: number
  packed: number | null
  packedIncomplete?: boolean
  time: number | null
  encrypted: boolean
}

declare global {
  interface Window {
    require?: (moduleName: string) => unknown
  }
}

/* ------------------------------------------------------------------ */
/* Electron bridge                                                     */
/* ------------------------------------------------------------------ */

let cachedIpc: IpcRendererLike | null | undefined

function getInitialDarkMode(): boolean {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return false
  try {
    return window.matchMedia('(prefers-color-scheme: dark)').matches
  } catch {
    return false
  }
}

function getIpc(): IpcRendererLike | null {
  if (cachedIpc !== undefined) return cachedIpc
  try {
    const requireFn = window.require
    if (typeof requireFn !== 'function') {
      cachedIpc = null
      return cachedIpc
    }
    const electron = requireFn('electron') as { ipcRenderer?: IpcRendererLike } | undefined
    cachedIpc = electron?.ipcRenderer ?? null
    return cachedIpc
  } catch {
    cachedIpc = null
    return cachedIpc
  }
}

let cachedWebUtils: WebUtilsLike | null | undefined

function getWebUtils(): WebUtilsLike | null {
  if (cachedWebUtils !== undefined) return cachedWebUtils
  try {
    const requireFn = window.require
    if (typeof requireFn !== 'function') {
      cachedWebUtils = null
      return cachedWebUtils
    }
    const electron = requireFn('electron') as { webUtils?: WebUtilsLike } | undefined
    cachedWebUtils = electron?.webUtils ?? null
    return cachedWebUtils
  } catch {
    cachedWebUtils = null
    return cachedWebUtils
  }
}

/** Resolve a dropped File to its host path (Electron exposes no File.path). */
function droppedFilePath(file: File): string | null {
  try {
    const fromWebUtils = getWebUtils()?.getPathForFile(file)
    if (fromWebUtils) return fromWebUtils
  } catch {
    /* fall through to the legacy property */
  }

  const legacy = file as File & { path?: string }
  return legacy.path || null
}

/* ------------------------------------------------------------------ */
/* Formatting + row building                                           */
/* ------------------------------------------------------------------ */

function formatBytes(bytes: number | null): string {
  if (bytes === null || !Number.isFinite(bytes)) return '—'
  if (bytes <= 0) return '0 bytes'
  if (bytes < 1024) return `${bytes} bytes`
  const units = ['KB', 'MB', 'GB', 'TB']
  let value = bytes / 1024
  let unit = 0
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024
    unit += 1
  }
  const digits = value >= 100 ? 0 : value >= 10 ? 1 : 2
  return `${value.toFixed(digits)} ${units[unit]}`
}

/** Short, uppercase label for the format pill and status messages. */
function formatLabel(format: string): string {
  if (!format) return 'ARCHIVE'
  if (format === 'scs') return 'SCS'
  if (format === '7z') return '7Z'
  return format.toUpperCase()
}

function formatDate(time: number | null): string {
  if (!time) return '—'
  const date = new Date(time)
  if (Number.isNaN(date.getTime())) return '—'
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(
    date.getHours(),
  )}:${pad(date.getMinutes())}`
}

function parentPath(path: string): string {
  if (!path) return ''
  const trimmed = path.endsWith('/') ? path.slice(0, -1) : path
  const index = trimmed.lastIndexOf('/')
  return index < 0 ? '' : trimmed.slice(0, index + 1)
}

/** Collapse the flat entry list into the direct children of `currentPath`. */
function buildRows(entries: ArchiveEntry[], currentPath: string): Row[] {
  const container = entries.find((entry) => entry.kind === 'container')
  if (container) {
    return [
      {
        key: container.name,
        name: container.name,
        type: 'container',
        size: container.size,
        packed: container.compressedSize,
        time: container.time,
        encrypted: false,
      },
    ]
  }

  const folders = new Map<string, Row>()
  const files: Row[] = []

  for (const entry of entries) {
    if (!entry.name.startsWith(currentPath)) continue
    const rest = entry.name.slice(currentPath.length)
    if (!rest) continue

    const slash = rest.indexOf('/')

    if (slash === -1 && !entry.isDirectory) {
      files.push({
        key: entry.name,
        name: rest,
        type: 'file',
        size: entry.size,
        packed: entry.compressedSize,
        time: entry.time,
        encrypted: entry.encrypted,
      })
      continue
    }

    const folderName = (slash === -1 ? rest : rest.slice(0, slash)).replace(/\/$/, '')
    if (!folderName) continue

    const key = `${currentPath}${folderName}/`
    let folder = folders.get(key)
    if (!folder) {
      folder = {
        key,
        name: folderName,
        type: 'folder',
        size: 0,
        packed: null,
        packedIncomplete: false,
        time: null,
        encrypted: false,
      }
      folders.set(key, folder)
    }
    if (!entry.isDirectory) {
      folder.size += entry.size
      if (entry.compressedSize !== null) {
        folder.packed = (folder.packed ?? 0) + entry.compressedSize
      } else {
        folder.packedIncomplete = true
      }
    }
  }

  for (const folder of folders.values()) {
    if (folder.packedIncomplete) folder.packed = null
    delete folder.packedIncomplete
  }

  return [...folders.values(), ...files]
}

function sortRows(rows: Row[], key: SortKey, direction: SortDir): Row[] {
  const sorted = [...rows]
  sorted.sort((a, b) => {
    if (a.type === 'folder' && b.type !== 'folder') return -1
    if (a.type !== 'folder' && b.type === 'folder') return 1

    let cmp: number
    if (key === 'name') {
      cmp = a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' })
    } else if (key === 'size') {
      cmp = a.size - b.size
    } else if (key === 'packed') {
      if (a.packed === null && b.packed === null) cmp = 0
      else if (a.packed === null) cmp = 1
      else if (b.packed === null) cmp = -1
      else cmp = a.packed - b.packed
    } else {
      cmp = (a.time ?? 0) - (b.time ?? 0)
    }

    if (cmp === 0) cmp = a.name.localeCompare(b.name, undefined, { numeric: true })
    return cmp * direction
  })
  return sorted
}

/** Expand selected folders into the concrete archive entry names. */
function collectSelection(entries: ArchiveEntry[], selected: Set<string>): string[] | undefined {
  if (selected.size === 0) return undefined
  const names = new Set<string>()
  for (const key of selected) {
    if (key.endsWith('/')) {
      for (const entry of entries) {
        if (entry.name.startsWith(key)) names.add(entry.name)
      }
    } else {
      names.add(key)
    }
  }
  return names.size > 0 ? [...names] : undefined
}

function splitPath(path: string): string[] {
  return path.split('/').filter(Boolean)
}

/* ------------------------------------------------------------------ */
/* Built-in editor helpers                                             */
/* ------------------------------------------------------------------ */

const EDITABLE_EXTENSIONS = new Set([
  'sii',
  'sui',
  'mat',
  'def',
  'txt',
  'cfg',
  'ini',
  'json',
  'xml',
  'lua',
  'md',
  'log',
  'toml',
  'yaml',
  'js',
  'ts',
])

function baseName(path: string): string {
  const parts = path.split(/[\\/]/)
  return parts[parts.length - 1] || path
}

function fileExtension(path: string): string {
  const name = baseName(path)
  const dot = name.lastIndexOf('.')
  return dot < 0 ? '' : name.slice(dot + 1).toLowerCase()
}

const IMAGE_EXTENSIONS = new Set(['png', 'jpg', 'jpeg', 'bmp', 'webp', 'ico', 'gif'])

const BINARY_EXTENSIONS = new Set([
  'pmd',
  'pmg',
  'pmc',
  'pma',
  'tobj',
  'dds',
  'tga',
  'ogg',
  'bank',
  'snd',
  'scs',
])

const ARCHIVE_EXTENSIONS = new Set([
  'zip',
  'scs',
  'rar',
  '7z',
  'tar',
  'gz',
  'bz2',
  'xz',
  'iso',
  'cab',
])

function isImageFile(path: string): boolean {
  return IMAGE_EXTENSIONS.has(fileExtension(path))
}

function isArchiveFile(path: string): boolean {
  return ARCHIVE_EXTENSIONS.has(fileExtension(path))
}

function createDragSessionId(): string {
  const value =
    typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
      ? crypto.randomUUID()
      : `${Date.now()}-${Math.random().toString(36).slice(2)}`
  return value.replace(/[^A-Za-z0-9_-]/g, '').slice(0, 96)
}

function dragSignature(roots: string[], entries: string[]): string {
  return JSON.stringify({
    roots: [...new Set(roots)].sort(),
    entries: [...new Set(entries)].sort(),
  })
}

function isEditableFile(path: string): boolean {
  return EDITABLE_EXTENSIONS.has(fileExtension(path))
}

function editorLanguageFor(path: string): string {
  switch (fileExtension(path)) {
    case 'json':
      return 'json'
    case 'xml':
      return 'xml'
    case 'ini':
    case 'cfg':
      return 'ini'
    case 'lua':
      return 'lua'
    case 'md':
      return 'markdown'
    case 'yaml':
      return 'yaml'
    case 'js':
      return 'javascript'
    case 'ts':
      return 'typescript'
    default:
      return 'plaintext'
  }
}

function editorLanguageLabel(path: string): string {
  const language = editorLanguageFor(path)
  return language === 'plaintext' ? 'Plain Text' : language.toUpperCase()
}

/* ------------------------------------------------------------------ */
/* App                                                                 */
/* ------------------------------------------------------------------ */

function App() {
  const [archive, setArchive] = useState<ArchiveInfo | null>(null)
  const [appVersion, setAppVersion] = useState('')
  const [archiveStack, setArchiveStack] = useState<ArchiveFrame[]>([])
  const [nestedInfo, setNestedInfo] = useState<NestedInfo | null>(null)
  const [nestedModified, setNestedModified] = useState(false)
  const parentModifiedByWritebackRef = useRef(false)
  const archiveStackRef = useRef<ArchiveFrame[]>([])
  const [currentPath, setCurrentPath] = useState('')
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [sortKey, setSortKey] = useState<SortKey>('name')
  const [sortDir, setSortDir] = useState<SortDir>(1)
  const [busy, setBusy] = useState<BusyState>(null)
  const [progress, setProgress] = useState<ProgressPayload | null>(null)
  const [status, setStatus] = useState<{ tone: Tone; text: string }>(() =>
    getIpc()
      ? { tone: 'info', text: 'Ready' }
      : {
          tone: 'error',
          text: 'Electron bridge unavailable. Launch the desktop app with "npm run electron:dev".',
        },
  )
  const [bridgeReady] = useState(() => getIpc() !== null)
  const [darkMode, setDarkMode] = useState<boolean>(getInitialDarkMode)
  const [editingFile, setEditingFile] = useState<EditingFile | null>(null)
  const [isSavingFile, setIsSavingFile] = useState(false)
  const [scsEdits, setScsEdits] = useState<Record<string, string>>({})
  const [scsSavedEdits, setScsSavedEdits] = useState<Record<string, string>>({})
  const [scsModPath, setScsModPath] = useState<string | null>(null)
  const [navigation, setNavigation] = useState<NavigationState>({ history: [], index: -1 })
  const [imagePreview, setImagePreview] = useState<ImagePreview | null>(null)
  const [imageSize, setImageSize] = useState<{ width: number; height: number } | null>(null)
  const [dragActive, setDragActive] = useState(false)
  const theme = darkMode ? 'dark' : 'light'

  const ipcRef = useRef<IpcRendererLike | null>(getIpc())
  const lastClickIndex = useRef<number | null>(null)
  const dragDepth = useRef(0)
  const dragSessionRef = useRef<string | null>(null)
  const dragPrepRef = useRef<DragPreparation>({ signature: '', ready: false })
  const dragRequestRef = useRef(0)
  const dragOutRef = useRef(false)
  const selectAllRef = useRef(false)

  useEffect(() => {
    const ipc = ipcRef.current
    if (!ipc) return
    void ipc
      .invoke('app:getVersion')
      .then((result) => {
        const info = result as { version?: unknown; packaged?: unknown } | null
        if (!info || typeof info.version !== 'string') return
        setAppVersion(`v${info.version}${info.packaged === true ? '' : '-dev'}`)
      })
      .catch(() => {
        /* version label is optional */
      })
  }, [])

  /* ----- system theme (Windows light/dark, live) ----- */

  useEffect(() => {
    if (typeof window.matchMedia !== 'function') return

    const media = window.matchMedia('(prefers-color-scheme: dark)')
    const onMediaChange = (event: MediaQueryListEvent) => setDarkMode(event.matches)
    media.addEventListener('change', onMediaChange)

    const ipc = ipcRef.current
    const onThemeChanged = (_event: unknown, payload: unknown) => {
      const dark = (payload as { dark?: unknown } | null)?.dark
      if (typeof dark === 'boolean') setDarkMode(dark)
    }
    ipc?.on('theme:changed', onThemeChanged)

    return () => {
      media.removeEventListener('change', onMediaChange)
      ipc?.removeListener('theme:changed', onThemeChanged)
    }
  }, [])

  useEffect(() => {
    const root = document.documentElement
    root.dataset.theme = theme
    root.style.colorScheme = theme
  }, [theme])

  /* ----- progress events ----- */

  useEffect(() => {
    const ipc = ipcRef.current
    if (!ipc) return

    const handler = (_event: unknown, payload: unknown) => {
      const update = payload as ProgressPayload | null
      if (!update) return
      if (update.phase === 'error') {
        setProgress(null)
        setStatus({ tone: 'error', text: update.message ?? 'Extraction failed.' })
        return
      }
      setProgress(update)
    }

    ipc.on('archive:progress', handler)
    return () => ipc.removeListener('archive:progress', handler)
  }, [])

  /* ----- derived data ----- */

  const rows = useMemo(() => {
    if (!archive) return []
    return sortRows(buildRows(archive.entries, currentPath), sortKey, sortDir)
  }, [archive, currentPath, sortKey, sortDir])

  const selectedEntryNames = useMemo(
    () => (archive ? collectSelection(archive.entries, selected) : undefined),
    [archive, selected],
  )

  const entrySizeMap = useMemo(() => {
    const sizes = new Map<string, number>()
    if (!archive) return sizes
    for (const entry of archive.entries) {
      // Packed HashFS texture rows expose size 0; use the packed size as a
      // safe fallback so the automatic-preparation cap cannot undercount them.
      sizes.set(entry.name, Math.max(entry.size, entry.compressedSize ?? 0))
    }
    return sizes
  }, [archive])

  const dragSelection = useMemo(() => {
    if (!archive) {
      return {
        roots: [] as string[],
        entries: [] as string[],
        signature: '',
        selectionBytes: 0,
        hasTopLevelFolder: false,
        archiveIsLarge: false,
      }
    }
    const roots = [...selected].sort()
    const entries = collectSelection(archive.entries, selected) ?? []
    return {
      roots,
      entries,
      signature: dragSignature(roots, entries),
      selectionBytes: selectionBytesFor(entrySizeMap, entries),
      hasTopLevelFolder: hasTopLevelFolder(roots),
      archiveIsLarge: archive.fileSize > AUTO_DRAG_PREP_LIMIT_BYTES,
    }
  }, [archive, entrySizeMap, selected])

  const isScsContainer = Boolean(
    archive && archive.entries.length === 1 && archive.entries[0].kind === 'container',
  )
  const isNestedArchive = archiveStack.length > 0
  const nestedReadOnlyReason = !isNestedArchive || !archive
    ? null
    : !isWritableArchiveFormat(archive.format)
      ? 'The inner archive is read-only.'
      : !archiveStack.every((frame) => isWritableArchiveFormat(frame.archive.format))
        ? 'The outer archive is read-only.'
        : null
  const nestedCanEdit = isNestedArchive && !nestedReadOnlyReason
  const nestedWriteBlocked = isNestedArchive && !nestedCanEdit
  const nestedReadOnlyMessage = nestedReadOnlyReason
    ? `${NESTED_READ_ONLY_MESSAGE} ${nestedReadOnlyReason}`
    : NESTED_READ_ONLY_MESSAGE
  const archiveChainLabel = archive
    ? [...archiveStack.map((frame) => frame.archive.fileName), archive.fileName].join(' > ')
    : ''
  const isHashFsArchive = Boolean(
    archive && archive.format === 'scs' && !isScsContainer && archive.entries.length > 0,
  )
  const scsEditedCount = Object.keys(scsEdits).length
  const scsHasUnappliedEdits = useMemo(() => {
    const keys = new Set([...Object.keys(scsEdits), ...Object.keys(scsSavedEdits)])
    for (const key of keys) {
      if (scsEdits[key] !== scsSavedEdits[key]) return true
    }
    return false
  }, [scsEdits, scsSavedEdits])

  const navHistory = navigation.history
  const navIndex = navigation.index
  const canNavigateBack =
    Boolean(editingFile || imagePreview) || navIndex > 0 || archiveStack.length > 0
  const canNavigateForward =
    !editingFile && !imagePreview && navIndex >= 0 && navIndex < navHistory.length - 1
  const canNavigateUp =
    Boolean(editingFile || imagePreview) ||
    Boolean(archive && currentPath) ||
    archiveStack.length > 0

  /* ----- actions ----- */

  const resetState = useCallback(() => {
    setCurrentPath('')
    setSelected(new Set())
    setProgress(null)
  }, [])

  useEffect(() => {
    archiveStackRef.current = archiveStack
  }, [archiveStack])

  const cleanupDragSession = useCallback(async () => {
    const ipc = ipcRef.current
    const sessionId = dragSessionRef.current
    dragSessionRef.current = null
    dragPrepRef.current = { signature: '', ready: false }
    dragRequestRef.current += 1

    if (!ipc || !sessionId) return
    try {
      await ipc.invoke('archive:cleanupDrag', { sessionId })
    } catch {
      /* best effort */
    }
  }, [])

  const invalidateDragPreparation = useCallback(() => {
    dragPrepRef.current = { signature: '', ready: false }
    dragRequestRef.current += 1
    setProgress(null)
  }, [])

  const popNestedArchive = useCallback(async () => {
    const frame = archiveStack[archiveStack.length - 1]
    if (!frame) return
    const ipc = ipcRef.current
    const nestedDragSession = dragSessionRef.current

    setArchiveStack((current) => current.slice(0, -1))
    setArchive(frame.archive)
    setCurrentPath(frame.currentPath)
    setSelected(new Set(frame.selected))
    setNavigation(frame.navigation)
    setScsEdits(frame.scsEdits)
    setScsSavedEdits(frame.scsSavedEdits)
    setScsModPath(frame.scsModPath)
    setNestedInfo(frame.nestedInfo)
    setNestedModified(
      frame.nestedModified || parentModifiedByWritebackRef.current,
    )
    parentModifiedByWritebackRef.current = false
    dragSessionRef.current = frame.dragSessionId
    dragPrepRef.current = { signature: '', ready: false }
    dragRequestRef.current += 1
    setEditingFile(null)
    setImagePreview(null)
    setProgress(null)
    setStatus({ tone: 'info', text: `Returned to ${frame.archive.fileName}` })

    if (ipc && nestedDragSession) {
      void ipc.invoke('archive:cleanupDrag', { sessionId: nestedDragSession }).catch(() => {})
    }
  }, [archiveStack])

  const commitNestedChanges = useCallback(async (): Promise<boolean> => {
    if (!isNestedArchive || !nestedModified || !nestedInfo || !archive) return true
    const parent = archiveStack[archiveStack.length - 1]
    const ipc = ipcRef.current
    if (!parent || !ipc) return false

    const innerName = baseName(nestedInfo.entryName)
    const outerName = parent.archive.fileName

    if (!window.confirm(`Save changes to ${innerName} inside ${outerName}?`)) {
      await ipc
        .invoke('archive:discardNested', {
          outerArchivePath: parent.archive.filePath,
          nestedFilePath: archive.filePath,
        })
        .catch(() => {})
      setNestedModified(false)
      setNestedInfo(null)
      return true
    }

    setBusy('writing')
    setProgress(null)
    setStatus({ tone: 'info', text: `Writing ${innerName} back to ${outerName}…` })

    try {
      let result = (await ipc.invoke('archive:writeBackNested', {
        outerArchivePath: parent.archive.filePath,
        entryName: nestedInfo.entryName,
        nestedFilePath: archive.filePath,
        confirmed: false,
      })) as WriteBackResult

      if (result?.needsWarning) {
        const reasons: string[] = []
        if (result.solid) {
          reasons.push('The outer archive is a solid 7z; updating it may take a while.')
        }
        if ((result.innerSize ?? 0) > NESTED_WRITEBACK_WARN_BYTES) {
          reasons.push(
            `The inner archive is ${formatBytes(result.innerSize ?? 0)}; writing it back may take a while.`,
          )
        }
        if (!window.confirm(`${reasons.join('\n\n')}\n\nContinue?`)) {
          setStatus({ tone: 'info', text: 'Write-back canceled.' })
          return false
        }
        result = (await ipc.invoke('archive:writeBackNested', {
          outerArchivePath: parent.archive.filePath,
          entryName: nestedInfo.entryName,
          nestedFilePath: archive.filePath,
          confirmed: true,
        })) as WriteBackResult
      }

      if (!result?.ok) {
        setStatus({
          tone: 'error',
          text: result?.error ?? 'Could not write the nested archive back to the outer archive.',
        })
        return false
      }

      const nestedDrag = dragSessionRef.current
      dragSessionRef.current = null
      dragPrepRef.current = { signature: '', ready: false }
      dragRequestRef.current += 1
      if (nestedDrag) {
        await ipc
          .invoke('archive:cleanupDrag', { sessionId: nestedDrag })
          .catch(() => {})
      }

      parentModifiedByWritebackRef.current = archiveStack.length > 1
      setNestedModified(false)
      setNestedInfo(null)
      setProgress(null)
      setStatus({ tone: 'success', text: `${innerName} written back to ${outerName}.` })
      return true
    } catch (error) {
      setStatus({
        tone: 'error',
        text:
          error instanceof Error
            ? error.message
            : 'Could not write the nested archive back to the outer archive.',
      })
      return false
    } finally {
      setBusy(null)
    }
  }, [archive, archiveStack, isNestedArchive, nestedInfo, nestedModified])

  const prepareDragSelection = useCallback(
    async (
      roots: string[],
      entries: string[],
      signature: string,
      selectionBytes: number,
      automatic: boolean,
      announce: boolean,
    ) => {
      const ipc = ipcRef.current
      const sessionId = dragSessionRef.current
      if (!ipc || !archive || !sessionId || entries.length === 0) return false

      const requestId = ++dragRequestRef.current
      if (announce) {
        setStatus({ tone: 'info', text: 'Preparing files…' })
      }

      try {
        const result = (await ipc.invoke('archive:prepareDrag', {
          sessionId,
          archivePath: archive.filePath,
          roots,
          entries,
          automatic,
          selectionBytes,
        })) as PrepareDragResult

        if (requestId !== dragRequestRef.current) return false

        if (!result || !result.success || !result.ready) {
          dragPrepRef.current = { signature, ready: false }
          setProgress(null)
          if (announce && !result?.skipped) {
            setStatus({
              tone: 'error',
              text: result?.error ?? 'Could not prepare these entries for dragging.',
            })
          }
          return false
        }

        dragPrepRef.current = { signature: result.signature ?? signature, ready: true }
        setProgress(null)
        if (announce) {
          setStatus({ tone: 'success', text: 'Files ready — drag again to drop them.' })
        }
        return true
      } catch (error) {
        dragPrepRef.current = { signature, ready: false }
        setProgress(null)
        if (announce) {
          setStatus({
            tone: 'error',
            text: error instanceof Error ? error.message : 'Could not prepare these entries for dragging.',
          })
        }
        return false
      }
    },
    [archive],
  )

  useEffect(() => {
    if (!archive || !dragSelection.signature || dragSelection.entries.length === 0) {
      dragPrepRef.current = { signature: '', ready: false }
      return
    }

    const automaticAllowed =
      !selectAllRef.current &&
      dragSelection.selectionBytes <= AUTO_DRAG_PREP_LIMIT_BYTES &&
      !(dragSelection.hasTopLevelFolder && dragSelection.archiveIsLarge)

    if (!automaticAllowed) return

    const timer = setTimeout(() => {
      void prepareDragSelection(
        dragSelection.roots,
        dragSelection.entries,
        dragSelection.signature,
        dragSelection.selectionBytes,
        true,
        false,
      )
    }, 250)

    return () => clearTimeout(timer)
  }, [archive, dragSelection, prepareDragSelection])

  useEffect(() => {
    const ipc = ipcRef.current
    if (!ipc) return

    const handler = (_event: unknown, message: unknown) => {
      setStatus({
        tone: 'error',
        text: typeof message === 'string' ? message : 'Could not start dragging these files.',
      })
    }

    ipc.on('archive:dragError', handler)
    return () => ipc.removeListener('archive:dragError', handler)
  }, [])

  const pushNavigation = useCallback((entry: NavigationEntry) => {
    setNavigation((previous) => {
      const stack = previous.history.slice(0, previous.index + 1)
      const current = stack[stack.length - 1]
      if (
        current &&
        current.type === entry.type &&
        current.path === entry.path &&
        current.entryName === entry.entryName
      ) {
        return { history: stack, index: stack.length - 1 }
      }
      stack.push(entry)
      return { history: stack, index: stack.length - 1 }
    })
  }, [])

  const navigateToFolder = useCallback(
    (folderPath: string) => {
      if (busy) return
      setEditingFile(null)
      setImagePreview(null)
      setCurrentPath(folderPath)
      setSelected(new Set())
      lastClickIndex.current = null
      pushNavigation({ type: 'folder', path: folderPath })
      setStatus({
        tone: 'info',
        text: folderPath ? `/${folderPath}` : archive ? `${archive.fileName} root` : 'Archive root',
      })
    },
    [archive, busy, pushNavigation],
  )

  const closeOverlayToFolder = useCallback((folderPath: string, statusText?: string) => {
    setEditingFile(null)
    setImagePreview(null)
    setCurrentPath(folderPath)
    setSelected(new Set())
    lastClickIndex.current = null
    setNavigation((previous) => {
      let targetIndex = previous.index
      if (previous.history[targetIndex] && previous.history[targetIndex].type !== 'folder') {
        for (let i = targetIndex - 1; i >= 0; i -= 1) {
          if (previous.history[i].type === 'folder') {
            targetIndex = i
            break
          }
        }
      }
      return { ...previous, index: targetIndex }
    })
    if (statusText) setStatus({ tone: 'info', text: statusText })
  }, [])

  const refreshArchive = useCallback(async () => {
    const ipc = ipcRef.current
    if (!ipc || !archive || busy) return

    setBusy('reading')
    setStatus({ tone: 'info', text: 'Refreshing archive…' })
    try {
      const result = (await ipc.invoke('archive:refresh', archive.filePath)) as ReadResult
      if (!result || !result.ok || !result.entries || !result.stats) {
        setStatus({ tone: 'error', text: result?.error ?? 'Could not refresh this archive.' })
        return
      }

      setArchive((current) => {
        if (!current) return current
        return {
          ...current,
          entries: result.entries ?? current.entries,
          stats: result.stats ?? current.stats,
          fileSize: result.fileSize ?? current.fileSize,
          note: result.note ?? current.note,
        }
      })
      setSelected(new Set())

      const folderStillExists =
        !currentPath || result.entries.some((entry) => entry.name.startsWith(currentPath))
      if (!folderStillExists) {
        setCurrentPath('')
        pushNavigation({ type: 'folder', path: '' })
      }
      setStatus({
        tone: 'success',
        text: `Refreshed ${archive.fileName} — ${result.stats.fileCount.toLocaleString()} files`,
      })
    } catch (error) {
      setStatus({
        tone: 'error',
        text: error instanceof Error ? error.message : 'Could not refresh this archive.',
      })
    } finally {
      setBusy(null)
    }
  }, [archive, busy, currentPath, pushNavigation])

  const loadArchive = useCallback(
    async (filePath: string) => {
      const ipc = ipcRef.current
      if (!ipc) return

      await cleanupDragSession()
      for (const frame of archiveStackRef.current) {
        if (!frame.dragSessionId) continue;
        await ipc
          .invoke('archive:cleanupDrag', { sessionId: frame.dragSessionId })
          .catch(() => {})
      }
      await ipc.invoke('archive:cleanupNested').catch(() => {})
      setArchiveStack([])
      setNestedInfo(null)
      setNestedModified(false)
      setEditingFile(null)
      setImagePreview(null)
      setScsEdits({})
      setScsSavedEdits({})
      setScsModPath(null)
      setNavigation({ history: [], index: -1 })
      setBusy('reading')
      setProgress(null)
      setStatus({ tone: 'info', text: 'Reading archive…' })

      try {
        const result = (await ipc.invoke('archive:read', filePath)) as ReadResult
        if (!result || !result.ok || !result.entries || !result.stats) {
          setArchive(null)
          setEditingFile(null)
          resetState()
          setStatus({ tone: 'error', text: result?.error ?? 'Could not read this archive.' })
          return
        }

        setArchive({
          filePath: result.filePath ?? filePath,
          fileName: result.fileName ?? filePath.split(/[\\/]/).pop() ?? filePath,
          fileSize: result.fileSize ?? 0,
          format: result.format ?? 'archive',
          entries: result.entries,
          stats: result.stats,
          note: result.note ?? null,
        })
        const loadedPath = result.filePath ?? filePath
        const loadedAsHashFs =
          result.format === 'scs' &&
          !(result.entries.length === 1 && result.entries[0].kind === 'container')
        if (loadedAsHashFs) {
          setScsModPath(readStoredScsModTarget(loadedPath))
        }
        dragSessionRef.current = createDragSessionId()
        dragPrepRef.current = { signature: '', ready: false }
        dragRequestRef.current += 1
        setNavigation({ history: [{ type: 'folder', path: '' }], index: 0 })
        resetState()
        const isContainer =
          result.entries.length === 1 && result.entries[0].kind === 'container'
        setStatus({
          tone: 'info',
          text: isContainer
            ? 'HashFS container detected — ready to unpack with the bundled SCS extractor.'
            : `${formatLabel(result.format ?? 'archive')} archive loaded — ${result.stats.fileCount} file${
                result.stats.fileCount === 1 ? '' : 's'
              }.`,
        })
      } catch (error) {
        setStatus({
          tone: 'error',
          text: error instanceof Error ? error.message : 'Could not read this archive.',
        })
      } finally {
        setBusy(null)
      }
    },
    [cleanupDragSession, resetState],
  )

  const handleOpenArchive = useCallback(async () => {
    const ipc = ipcRef.current
    if (!ipc || busy) return

    const picked = (await ipc.invoke('dialog:openArchive')) as OpenResult
    if (!picked || picked.canceled || !picked.filePath) return

    if (editingFile?.isDirty && !window.confirm('Discard unsaved changes?')) return
    if (scsHasUnappliedEdits && !window.confirm('Discard HashFS edits that were not saved to the mod?')) {
      return
    }
    if (!(await commitNestedChanges())) return
    await loadArchive(picked.filePath)
  }, [busy, commitNestedChanges, editingFile, loadArchive, scsHasUnappliedEdits])

  useEffect(() => {
    const ipc = ipcRef.current
    if (!ipc) return

    ipc
      .invoke('archive:initialPath')
      .then((path) => {
        if (typeof path === 'string' && path) void loadArchive(path)
      })
      .catch(() => {
        /* no startup archive */
      })
  }, [loadArchive])

  const handleExtractTo = useCallback(async () => {
    const ipc = ipcRef.current
    if (!ipc || !archive || busy) return

    const picked = (await ipc.invoke('dialog:selectOutputDir')) as OpenResult
    if (!picked || picked.canceled || !picked.filePath) return

    const outputDir = picked.filePath
    setBusy('extracting')
    setProgress({ format: archive.format, phase: 'extracting', percent: 0, message: 'Preparing extraction…' })
    setStatus({ tone: 'info', text: 'Extracting…' })

    try {
      const result = (await ipc.invoke('archive:extract', {
        filePath: archive.filePath,
        outputDir,
        entries: selectedEntryNames,
      })) as ExtractResult

      if (!result || !result.ok) {
        setProgress(null)
        setStatus({ tone: 'error', text: result?.error ?? 'Extraction failed.' })
        return
      }

      setStatus({ tone: 'success', text: result.message ?? 'Extraction complete.' })
      setProgress({
        format: archive.format,
        phase: 'done',
        percent: 100,
        done: result.extracted ?? null,
        total: result.total ?? null,
        message: result.message,
      })
    } catch (error) {
      setProgress(null)
      setStatus({
        tone: 'error',
        text: error instanceof Error ? error.message : 'Extraction failed.',
      })
    } finally {
      setBusy(null)
    }
  }, [archive, busy, selectedEntryNames])

  const handleClose = useCallback(() => {
    void (async () => {
      if (busy) return
      if (editingFile?.isDirty && !window.confirm('Discard unsaved changes?')) return
      if (
        scsHasUnappliedEdits &&
        !window.confirm('Discard HashFS edits that were not saved to the mod?')
      ) {
        return
      }
      if (!(await commitNestedChanges())) return
      void cleanupDragSession()
      const ipc = ipcRef.current
      for (const frame of archiveStack) {
        if (!frame.dragSessionId) continue;
        void ipc?.invoke('archive:cleanupDrag', { sessionId: frame.dragSessionId }).catch(() => {})
      }
      void ipc?.invoke('archive:cleanupNested').catch(() => {})
      setArchiveStack([])
      setNestedInfo(null)
      setNestedModified(false)
      setEditingFile(null)
      setImagePreview(null)
      setScsEdits({})
      setScsSavedEdits({})
      setScsModPath(null)
      setNavigation({ history: [], index: -1 })
      setArchive(null)
      resetState()
      setStatus({ tone: 'info', text: 'Archive closed' })
    })()
  }, [
    archiveStack,
    busy,
    cleanupDragSession,
    commitNestedChanges,
    editingFile,
    resetState,
    scsHasUnappliedEdits,
  ])

  const handleCloseEditor = useCallback(() => {
    if (!editingFile) return
    if (editingFile.isDirty && !window.confirm('Discard unsaved changes?')) return
    closeOverlayToFolder(currentPath, 'Editor closed')
  }, [closeOverlayToFolder, currentPath, editingFile])

  const handleOpenImage = useCallback(
    async (entryName: string, recordHistory = true) => {
      const ipc = ipcRef.current
      if (!ipc || !archive || busy) return

      setBusy('reading')
      setImageSize(null)
      setStatus({ tone: 'info', text: `Loading ${baseName(entryName)}…` })

      try {
        const result = (await ipc.invoke('archive:readImage', {
          archivePath: archive.filePath,
          entryName,
        })) as ReadImageResult

        if (!result || !result.success || typeof result.base64 !== 'string') {
          setStatus({ tone: 'error', text: result?.error ?? 'Could not open this image.' })
          return
        }

        setImagePreview({ name: entryName, dataUrl: result.base64 })
        if (recordHistory) {
          pushNavigation({ type: 'image', path: currentPath, entryName })
        }
        setStatus({ tone: 'info', text: `Viewing ${baseName(entryName)}` })
      } catch (error) {
        setStatus({
          tone: 'error',
          text: error instanceof Error ? error.message : 'Could not open this image.',
        })
      } finally {
        setBusy(null)
      }
    },
    [archive, busy, currentPath, pushNavigation],
  )

  const refreshArchiveEntries = useCallback(async (filePath: string) => {
    const ipc = ipcRef.current
    if (!ipc) return false

    const result = (await ipc.invoke('archive:read', filePath)) as ReadResult
    if (!result || !result.ok || !result.entries || !result.stats) return false

    const entries = result.entries
    const stats = result.stats
    setArchive((current) => {
      if (!current || current.filePath !== filePath) return current
      return {
        ...current,
        entries,
        stats,
        fileSize: result.fileSize ?? current.fileSize,
        note: result.note ?? null,
      }
    })
    return true
  }, [])

  const handleDroppedPaths = useCallback(
    async (paths: string[]) => {
      if (busy || paths.length === 0) return
      const ipc = ipcRef.current
      if (!ipc) return

      const writable = archive
        ? archive.format === 'zip' || archive.format === '7z' || archive.format === 'tar'
        : false
      const canAddDroppedArchive =
        archive !== null && writable && (!isNestedArchive || nestedCanEdit)

      if (paths.length === 1 && isArchiveFile(paths[0])) {
        let shouldOpen = !canAddDroppedArchive
        if (canAddDroppedArchive) {
          let choice: 'add' | 'open' | 'cancel'
          try {
            choice = (await ipc.invoke('dialog:dropChoice', {
              fileName: baseName(paths[0]),
            })) as 'add' | 'open' | 'cancel'
          } catch (error) {
            setStatus({
              tone: 'error',
              text: error instanceof Error ? error.message : 'Could not ask what to do with this archive.',
            })
            return
          }
          if (choice === 'cancel') return
          shouldOpen = choice === 'open'
        }

        if (shouldOpen) {
          if (editingFile?.isDirty && !window.confirm('Discard unsaved changes?')) return
          if (
            scsHasUnappliedEdits &&
            !window.confirm('Discard HashFS edits that were not saved to the mod?')
          ) {
            return
          }
          if (!(await commitNestedChanges())) return
          await loadArchive(paths[0])
          return
        }
      }

      if (!archive) {
        setStatus({ tone: 'info', text: 'Open an archive before adding files.' })
        return
      }

      if (isNestedArchive && !nestedCanEdit) {
        setStatus({ tone: 'error', text: nestedReadOnlyMessage })
        return
      }

      const isContainer =
        archive.entries.length === 1 && archive.entries[0].kind === 'container'
      if (isContainer || !writable) {
        setStatus({ tone: 'error', text: 'This archive format is read-only. Cannot inject files.' })
        return
      }

      if (!window.confirm(`Add ${paths.length} item(s) to archive?`)) return

      const targetDir = currentPath.replace(/\/$/, '')
      setBusy('adding')
      setStatus({ tone: 'info', text: `Adding ${paths.length} item(s)…` })

      try {
        const result = (await ipc.invoke('archive:addFiles', {
          archivePath: archive.filePath,
          filePaths: paths,
          targetDir,
        })) as AddFilesResult

        if (!result || !result.success) {
          setStatus({ tone: 'error', text: result?.error ?? 'Could not add files to the archive.' })
          return
        }

        await refreshArchiveEntries(archive.filePath)
        setSelected(new Set())
        invalidateDragPreparation()
        if (isNestedArchive) setNestedModified(true)
        const added = result.added ?? paths.length
        setStatus({
          tone: 'success',
          text: `Added ${added} item${added === 1 ? '' : 's'} to archive`,
        })
      } catch (error) {
        setStatus({
          tone: 'error',
          text: error instanceof Error ? error.message : 'Could not add files to the archive.',
        })
      } finally {
        setBusy(null)
      }
    },
    [
      archive,
      busy,
      commitNestedChanges,
      currentPath,
      editingFile,
      invalidateDragPreparation,
      isNestedArchive,
      loadArchive,
      nestedCanEdit,
      nestedReadOnlyMessage,
      refreshArchiveEntries,
      scsHasUnappliedEdits,
    ],
  )

  const handleDragEnter = useCallback((event: React.DragEvent<HTMLDivElement>) => {
    if (dragOutRef.current) return
    event.preventDefault()
    dragDepth.current += 1
    setDragActive(true)
  }, [])

  const handleDragOver = useCallback((event: React.DragEvent<HTMLDivElement>) => {
    if (dragOutRef.current) return
    event.preventDefault()
    if (event.dataTransfer) event.dataTransfer.dropEffect = 'copy'
  }, [])

  const handleDragLeave = useCallback((event: React.DragEvent<HTMLDivElement>) => {
    event.preventDefault()
    dragDepth.current = Math.max(0, dragDepth.current - 1)
    if (dragDepth.current === 0) setDragActive(false)
  }, [])

  const handleDrop = useCallback(
    (event: React.DragEvent<HTMLDivElement>) => {
      event.preventDefault()
      dragDepth.current = 0
      setDragActive(false)
      if (dragOutRef.current) return

      const files = Array.from(event.dataTransfer?.files ?? [])
      if (files.length === 0) return

      const paths = files
        .map(droppedFilePath)
        .filter((candidate): candidate is string => Boolean(candidate))

      if (paths.length === 0) {
        setStatus({ tone: 'error', text: 'Could not read the dropped file paths.' })
        return
      }

      void handleDroppedPaths(paths)
    },
    [handleDroppedPaths],
  )

  const handleExternalLink = useCallback(
    async (event: React.MouseEvent<HTMLAnchorElement>, url: string) => {
      event.preventDefault()
      const ipc = ipcRef.current
      if (!ipc) {
        setStatus({ tone: 'error', text: 'External links are unavailable outside the desktop app.' })
        return
      }

      try {
        const result = (await ipc.invoke('shell:openExternal', url)) as OpenExternalResult
        if (!result || !result.success) {
          setStatus({ tone: 'error', text: result?.error ?? 'Could not open the link.' })
          return
        }
        setStatus({ tone: 'info', text: 'Opened link in your default browser' })
      } catch (error) {
        setStatus({
          tone: 'error',
          text: error instanceof Error ? error.message : 'Could not open the link.',
        })
      }
    },
    [],
  )

  const handleOpenFile = useCallback(
    async (entryName: string, recordHistory = true) => {
      const ipc = ipcRef.current
      if (!ipc || !archive || busy) return

      if (isHashFsArchive && scsEdits[entryName] !== undefined) {
        setEditingFile({ name: entryName, content: scsEdits[entryName], isDirty: false })
        if (recordHistory) {
          pushNavigation({ type: 'editor', path: currentPath, entryName })
        }
        setStatus({
          tone: 'info',
          text: `Editing ${baseName(entryName)} — opened from the edited mod overlay`,
        })
        return
      }

      setBusy('reading')
      setStatus({ tone: 'info', text: `Opening ${baseName(entryName)}…` })

      try {
        const result = (await ipc.invoke('archive:readFile', {
          archivePath: archive.filePath,
          entryName,
        })) as ReadFileResult

        if (!result || !result.success || typeof result.content !== 'string') {
          setStatus({ tone: 'error', text: result?.error ?? 'Could not open this file.' })
          return
        }

        setEditingFile({ name: entryName, content: result.content, isDirty: false })
        if (recordHistory) {
          pushNavigation({ type: 'editor', path: currentPath, entryName })
        }
        setStatus({
          tone: 'info',
          text: isHashFsArchive
            ? `Editing ${baseName(entryName)} — Ctrl+S saves to the mod package`
            : `Editing ${baseName(entryName)} — Ctrl+S saves to the archive`,
        })
      } catch (error) {
        setStatus({
          tone: 'error',
          text: error instanceof Error ? error.message : 'Could not open this file.',
        })
      } finally {
        setBusy(null)
      }
    },
    [archive, busy, currentPath, isHashFsArchive, pushNavigation, scsEdits],
  )

  const restoreNavigation = useCallback(
    (index: number) => {
      const entry = navHistory[index]
      if (!entry || busy) return

      setNavigation((previous) => ({ ...previous, index }))
      setSelected(new Set())
      lastClickIndex.current = null

      if (entry.type === 'folder') {
        setEditingFile(null)
        setImagePreview(null)
        setCurrentPath(entry.path)
        setStatus({
          tone: 'info',
          text: entry.path ? `/${entry.path}` : archive ? `${archive.fileName} root` : 'Archive root',
        })
        return
      }

      setImagePreview(null)
      setEditingFile(null)
      setCurrentPath(entry.path)
      if (!entry.entryName) return

      if (entry.type === 'editor') {
        void handleOpenFile(entry.entryName, false)
      } else {
        void handleOpenImage(entry.entryName, false)
      }
    },
    [archive, busy, handleOpenFile, handleOpenImage, navHistory],
  )

  const handleNavigateBack = useCallback(() => {
    if (busy) return

    if (editingFile || imagePreview) {
      if (editingFile?.isDirty && !window.confirm('Discard unsaved changes?')) return
      const folderPath = editingFile ? parentPath(editingFile.name) : currentPath
      closeOverlayToFolder(folderPath, 'Back to archive folder')
      return
    }

    if (navIndex > 0) {
      restoreNavigation(navIndex - 1)
      return
    }
    if (archiveStack.length > 0) {
      if (nestedModified) {
        void (async () => {
          if (await commitNestedChanges()) void popNestedArchive()
        })()
        return
      }
      void popNestedArchive()
    }
  }, [
    archiveStack.length,
    busy,
    closeOverlayToFolder,
    commitNestedChanges,
    currentPath,
    editingFile,
    imagePreview,
    navIndex,
    nestedModified,
    popNestedArchive,
    restoreNavigation,
  ])

  const handleNavigateForward = useCallback(() => {
    if (busy || editingFile || imagePreview) return
    if (navIndex < navHistory.length - 1) restoreNavigation(navIndex + 1)
  }, [busy, editingFile, imagePreview, navHistory.length, navIndex, restoreNavigation])

  const handleNavigateUp = useCallback(() => {
    if (busy) return

    if (editingFile || imagePreview) {
      if (editingFile?.isDirty && !window.confirm('Discard unsaved changes?')) return
      const folderPath = editingFile ? parentPath(editingFile.name) : currentPath
      closeOverlayToFolder(folderPath, 'Returned to archive folder')
      return
    }

    if (!archive || !currentPath) {
      if (archiveStack.length > 0) {
        if (nestedModified) {
          void (async () => {
            if (await commitNestedChanges()) void popNestedArchive()
          })()
          return
        }
        void popNestedArchive()
      }
      return
    }
    navigateToFolder(parentPath(currentPath))
  }, [
    archive,
    archiveStack.length,
    busy,
    closeOverlayToFolder,
    commitNestedChanges,
    currentPath,
    editingFile,
    imagePreview,
    navigateToFolder,
    nestedModified,
    popNestedArchive,
  ])

  const ensureScsModTarget = useCallback(async (): Promise<string | null> => {
    const ipc = ipcRef.current
    if (!ipc || !archive) return null
    if (scsModPath) return scsModPath

    const picked = (await ipc.invoke('archive:chooseScsModPath', {
      archivePath: archive.filePath,
    })) as ChoosePathResult
    if (picked?.error) {
      setStatus({ tone: 'error', text: picked.error })
      return null
    }
    if (!picked || picked.canceled || !picked.filePath) return null

    setScsModPath(picked.filePath)
    storeScsModTarget(archive.filePath, picked.filePath)
    return picked.filePath
  }, [archive, scsModPath])

  const handleChangeScsModTarget = useCallback(async () => {
    const ipc = ipcRef.current
    if (!ipc || !archive || busy) return
    if (isNestedArchive && !nestedCanEdit) {
      setStatus({ tone: 'error', text: nestedReadOnlyMessage })
      return
    }

    const picked = (await ipc.invoke('archive:chooseScsModPath', {
      archivePath: archive.filePath,
    })) as ChoosePathResult
    if (picked?.error) {
      setStatus({ tone: 'error', text: picked.error })
      return
    }
    if (!picked || picked.canceled || !picked.filePath) return

    setScsModPath(picked.filePath)
    storeScsModTarget(archive.filePath, picked.filePath)
    setStatus({ tone: 'info', text: `Mod target set to ${picked.filePath}` })
  }, [archive, busy, isNestedArchive, nestedCanEdit, nestedReadOnlyMessage])

  const handleRevertScsEdit = useCallback(async () => {
    const ipc = ipcRef.current
    if (!ipc || !archive || !editingFile || !isHashFsArchive || isSavingFile) return
    if (isNestedArchive && !nestedCanEdit) {
      setStatus({ tone: 'error', text: nestedReadOnlyMessage })
      return
    }

    setIsSavingFile(true)
    try {
      const original = (await ipc.invoke('archive:readFile', {
        archivePath: archive.filePath,
        entryName: editingFile.name,
      })) as ReadFileResult
      if (!original || !original.success || typeof original.content !== 'string') {
        setStatus({ tone: 'error', text: original?.error ?? 'Could not reload the original file.' })
        return
      }

      const hadSavedEdit = Object.prototype.hasOwnProperty.call(scsSavedEdits, editingFile.name)
      const nextEdits = { ...scsEdits }
      delete nextEdits[editingFile.name]

      if (hadSavedEdit && scsModPath) {
        const result = (await ipc.invoke('archive:saveScsMod', {
          archivePath: archive.filePath,
          modPath: scsModPath,
          files: Object.entries(nextEdits).map(([entryName, content]) => ({ entryName, content })),
        })) as SaveScsModResult
        if (!result || !result.success) {
          setStatus({ tone: 'error', text: result?.error ?? 'Could not update the mod package.' })
          return
        }
      }

      setScsEdits(nextEdits)
      setScsSavedEdits((current) => {
        const copy = { ...current }
        delete copy[editingFile.name]
        return copy
      })
      setEditingFile({ name: editingFile.name, content: original.content, isDirty: false })
      invalidateDragPreparation()
      setStatus({
        tone: 'success',
        text: `Reverted ${baseName(editingFile.name)}${
          hadSavedEdit && scsModPath ? ' and updated the mod package' : ''
        }`,
      })
    } catch (error) {
      setStatus({
        tone: 'error',
        text: error instanceof Error ? error.message : 'Could not revert this edit.',
      })
    } finally {
      setIsSavingFile(false)
    }
  }, [
    archive,
    editingFile,
    invalidateDragPreparation,
    isHashFsArchive,
    isNestedArchive,
    isSavingFile,
    nestedCanEdit,
    nestedReadOnlyMessage,
    scsEdits,
    scsModPath,
    scsSavedEdits,
  ])

  const handleSaveScsCopy = useCallback(async () => {
    const ipc = ipcRef.current
    if (!ipc || !archive || !editingFile || !isHashFsArchive || busy || isSavingFile) return
    if (isNestedArchive && !nestedCanEdit) {
      setStatus({ tone: 'error', text: nestedReadOnlyMessage })
      return
    }

    const currentEdits = { ...scsEdits }
    if (editingFile.isDirty || currentEdits[editingFile.name] !== undefined) {
      currentEdits[editingFile.name] = editingFile.content
    }
    if (Object.keys(currentEdits).length === 0) {
      setStatus({ tone: 'info', text: 'Edit a file before saving a modified copy.' })
      return
    }

    const picked = (await ipc.invoke('archive:chooseScsCopyPath', {
      archivePath: archive.filePath,
    })) as ChoosePathResult
    if (picked?.error) {
      setStatus({ tone: 'error', text: picked.error })
      return
    }
    if (!picked || picked.canceled || !picked.filePath) return

    setBusy('writing')
    setIsSavingFile(true)
    setProgress({
      format: 'scs',
      phase: 'writing',
      percent: 0,
      message: 'Preparing modified HashFS copy…',
    })
    setStatus({ tone: 'info', text: 'Writing modified HashFS copy…' })

    try {
      const result = (await ipc.invoke('archive:saveScsCopy', {
        archivePath: archive.filePath,
        outputPath: picked.filePath,
        files: Object.entries(currentEdits).map(([entryName, content]) => ({
          entryName,
          content,
        })),
      })) as SaveScsCopyResult

      if (!result || !result.success) {
        setProgress(null)
        setStatus({ tone: 'error', text: result?.error ?? 'Could not write the modified copy.' })
        return
      }

      setProgress({
        format: 'scs',
        phase: 'done',
        percent: 100,
        done: result.edited?.length ?? null,
        total: result.edited?.length ?? null,
        message: 'Modified copy written',
      })
      setStatus({
        tone: 'success',
        text: `Modified copy saved to ${baseName(result.outputPath ?? picked.filePath)} (original untouched)`,
      })
    } catch (error) {
      setProgress(null)
      setStatus({
        tone: 'error',
        text: error instanceof Error ? error.message : 'Could not write the modified copy.',
      })
    } finally {
      setBusy(null)
      setIsSavingFile(false)
    }
  }, [
    archive,
    busy,
    editingFile,
    isHashFsArchive,
    isNestedArchive,
    isSavingFile,
    nestedCanEdit,
    nestedReadOnlyMessage,
    scsEdits,
  ])

  const handleSaveFile = useCallback(async () => {
    const ipc = ipcRef.current
    if (!ipc || !archive || !editingFile || isSavingFile) return
    if (isNestedArchive && !nestedCanEdit) {
      setStatus({ tone: 'error', text: nestedReadOnlyMessage })
      return
    }

    if (isHashFsArchive) {
      const target = await ensureScsModTarget()
      if (!target) return

      setIsSavingFile(true)
      setStatus({ tone: 'info', text: `Saving ${baseName(editingFile.name)} to the mod package…` })
      const nextEdits = { ...scsEdits, [editingFile.name]: editingFile.content }

      try {
        const result = (await ipc.invoke('archive:saveScsMod', {
          archivePath: archive.filePath,
          modPath: target,
          files: Object.entries(nextEdits).map(([entryName, content]) => ({ entryName, content })),
        })) as SaveScsModResult

        if (!result || !result.success) {
          setStatus({ tone: 'error', text: result?.error ?? 'Could not save to the mod package.' })
          return
        }

        setScsEdits(nextEdits)
        setScsSavedEdits(nextEdits)
        setEditingFile((current) => (current ? { ...current, isDirty: false } : current))
        invalidateDragPreparation()
        setStatus({
          tone: 'success',
          text: `Saved ${result.fileCount ?? Object.keys(nextEdits).length} edited file${
            (result.fileCount ?? 1) === 1 ? '' : 's'
          } to ${baseName(target)} — original game archive untouched`,
        })
      } catch (error) {
        setStatus({
          tone: 'error',
          text: error instanceof Error ? error.message : 'Could not save to the mod package.',
        })
      } finally {
        setIsSavingFile(false)
      }
      return
    }

    setIsSavingFile(true)
    setStatus({ tone: 'info', text: `Saving ${baseName(editingFile.name)}…` })

    try {
      const result = (await ipc.invoke('archive:saveFile', {
        archivePath: archive.filePath,
        entryName: editingFile.name,
        newContent: editingFile.content,
      })) as SaveFileResult

      if (!result || !result.success) {
        setStatus({ tone: 'error', text: result?.error ?? 'Could not save the file.' })
        return
      }

      setEditingFile((current) => (current ? { ...current, isDirty: false } : current))

      const bytes = new TextEncoder().encode(editingFile.content).length
      setArchive((current) => {
        if (!current) return current
        let totalSize = 0
        const entries = current.entries.map((entry) => {
          const updated =
            entry.name === editingFile.name ? { ...entry, size: bytes, time: Date.now() } : entry
          if (!updated.isDirectory) totalSize += updated.size
          return updated
        })
        return { ...current, entries, stats: { ...current.stats, totalSize } }
      })

      invalidateDragPreparation()
      if (isNestedArchive) setNestedModified(true)
      setStatus({
        tone: 'success',
        text: `Saved & updated ${editingFile.name} inside archive`,
      })
    } catch (error) {
      setStatus({
        tone: 'error',
        text: error instanceof Error ? error.message : 'Could not save the file.',
      })
    } finally {
      setIsSavingFile(false)
    }
  }, [
    archive,
    editingFile,
    ensureScsModTarget,
    invalidateDragPreparation,
    isHashFsArchive,
    isNestedArchive,
    isSavingFile,
    nestedCanEdit,
    nestedReadOnlyMessage,
    scsEdits,
  ])

  const toggleSort = useCallback((key: SortKey) => {
    setSortKey((currentKey) => {
      if (currentKey === key) {
        setSortDir((direction) => (direction === 1 ? -1 : 1))
        return currentKey
      }
      setSortDir(1)
      return key
    })
  }, [])

  const handleSelect = useCallback(
    (row: Row, index: number, event: React.MouseEvent) => {
      selectAllRef.current = false
      setSelected((current) => {
        const next = new Set(current)
        if (event.shiftKey && lastClickIndex.current !== null) {
          const [from, to] = [lastClickIndex.current, index].sort((a, b) => a - b)
          for (let i = from; i <= to; i += 1) next.add(rows[i].key)
        } else if (event.ctrlKey || event.metaKey) {
          if (next.has(row.key)) next.delete(row.key)
          else next.add(row.key)
        } else {
          next.clear()
          next.add(row.key)
        }
        return next
      })
      lastClickIndex.current = index
    },
    [rows],
  )

  const handleRowDragStart = useCallback(
    (event: React.DragEvent<HTMLTableRowElement>, row: Row) => {
      if (!archive || busy) {
        event.preventDefault()
        return
      }

      const keys = selected.has(row.key) ? new Set(selected) : new Set([row.key])
      if (!selected.has(row.key)) {
        setSelected(keys)
        lastClickIndex.current = null
      }

      const roots = [...keys].sort()
      const entries = collectSelection(archive.entries, keys) ?? []
      if (entries.length === 0) {
        event.preventDefault()
        setStatus({ tone: 'info', text: 'There are no files in this selection to drag.' })
        return
      }

      // Electron requires the renderer to prevent Chromium's default drag and
      // let the main process call webContents.startDrag during the gesture.
      event.preventDefault()
      event.dataTransfer.effectAllowed = 'copy'
      dragOutRef.current = true
      window.setTimeout(() => {
        dragOutRef.current = false
      }, 800)

      const signature = dragSignature(roots, entries)
      const selectionBytes = selectionBytesFor(entrySizeMap, entries)
      const preparation = dragPrepRef.current
      if (!preparation.ready || preparation.signature !== signature) {
        void prepareDragSelection(
          roots,
          entries,
          signature,
          selectionBytes,
          false,
          true,
        )
        return
      }

      const ipc = ipcRef.current
      const sessionId = dragSessionRef.current
      if (!ipc || !sessionId) {
        setStatus({ tone: 'error', text: 'The drag session is not ready.' })
        return
      }

      ipc.send('archive:startDrag', { sessionId, signature })
    },
    [archive, busy, entrySizeMap, prepareDragSelection, selected],
  )

  const handleRowDragEnd = useCallback(() => {
    dragOutRef.current = false
  }, [])

  const handleRowMouseDown = useCallback(
    (event: React.MouseEvent<HTMLTableRowElement>, row: Row) => {
      if (event.button !== 0 || !archive || busy || editingFile || imagePreview) return
      if (row.type === 'container') return

      selectAllRef.current = false
      const keys = selected.has(row.key) ? new Set(selected) : new Set([row.key])
      const roots = [...keys].sort()
      const entries = collectSelection(archive.entries, keys) ?? []
      if (entries.length === 0) return

      const selectionBytes = selectionBytesFor(entrySizeMap, entries)
      const automaticAllowed =
        selectionBytes <= AUTO_DRAG_PREP_LIMIT_BYTES &&
        !(hasTopLevelFolder(roots) && archive.fileSize > AUTO_DRAG_PREP_LIMIT_BYTES)
      if (!automaticAllowed) return

      const signature = dragSignature(roots, entries)
      if (dragPrepRef.current.ready && dragPrepRef.current.signature === signature) return

      void prepareDragSelection(roots, entries, signature, selectionBytes, true, false)
    },
    [
      archive,
      busy,
      editingFile,
      entrySizeMap,
      imagePreview,
      prepareDragSelection,
      selected,
    ],
  )

  const openNestedArchive = useCallback(
    async (entryName: string) => {
      const ipc = ipcRef.current
      if (!ipc || !archive || busy || editingFile || imagePreview) return
      if (!isNestedArchiveEntry(entryName)) return

      const entry = archive.entries.find((candidate) => candidate.name === entryName)
      if (!entry || entry.isDirectory) return

      const parentFrame: ArchiveFrame = {
        archive,
        currentPath,
        navigation,
        dragSessionId: dragSessionRef.current,
        scsEdits,
        scsSavedEdits,
        scsModPath,
        selected: new Set(selected),
        nestedModified,
        nestedInfo,
      }

      setBusy('nested')
      setProgress(null)
      setStatus({ tone: 'info', text: `Extracting ${baseName(entryName)} from the outer archive…` })

      try {
        let result = (await ipc.invoke('archive:openNested', {
          outerArchivePath: archive.filePath,
          entryName,
          confirmed: false,
        })) as OpenNestedResult

        if (result?.needsConfirmation) {
          const size = result.entrySize ?? entry.size
          const confirmed = window.confirm(
            `This entry is ${formatBytes(size)}. Extract it and open it from inside ${archive.fileName}?`,
          )
          if (!confirmed) {
            setStatus({ tone: 'info', text: 'Nested archive was not opened.' })
            return
          }
          result = (await ipc.invoke('archive:openNested', {
            outerArchivePath: archive.filePath,
            entryName,
            confirmed: true,
          })) as OpenNestedResult
        }

        if (!result || !result.ok || !result.filePath) {
          setStatus({
            tone: 'error',
            text: result?.error ?? 'Could not open this nested archive.',
          })
          return
        }

        const read = (await ipc.invoke('archive:read', result.filePath)) as ReadResult
        if (!read || !read.ok || !read.entries || !read.stats) {
          setStatus({
            tone: 'error',
            text: read?.error ?? 'Could not read the nested archive.',
          })
          return
        }

        setArchiveStack((current) => [...current, parentFrame])
        setNestedInfo({
          outerArchivePath: result.outerArchivePath ?? archive.filePath,
          entryName: result.entryName ?? entryName,
          filePath: result.filePath,
          sessionId: result.sessionId ?? '',
        })
        setNestedModified(false)
        dragSessionRef.current = createDragSessionId()
        dragPrepRef.current = { signature: '', ready: false }
        dragRequestRef.current += 1
        setArchive({
          filePath: read.filePath ?? result.filePath,
          fileName:
            read.fileName ?? result.entryName ?? baseName(result.filePath),
          fileSize: read.fileSize ?? result.entrySize ?? 0,
          format: read.format ?? 'archive',
          entries: read.entries,
          stats: read.stats,
          note: read.note ?? null,
        })
        setEditingFile(null)
        setImagePreview(null)
        setScsEdits({})
        setScsSavedEdits({})
        setScsModPath(null)
        setNavigation({ history: [{ type: 'folder', path: '' }], index: 0 })
        setCurrentPath('')
        setSelected(new Set())
        setProgress(null)
        setStatus({
          tone: 'info',
          text: `${result.cached ? 'Reopened cached' : 'Opened'} ${result.entryName} from ${archive.fileName}.`,
        })
      } catch (error) {
        setStatus({
          tone: 'error',
          text: error instanceof Error ? error.message : 'Could not open this nested archive.',
        })
      } finally {
        setBusy(null)
      }
    },
    [
      archive,
      busy,
      currentPath,
      editingFile,
      imagePreview,
      navigation,
      nestedInfo,
      nestedModified,
      scsEdits,
      scsModPath,
      scsSavedEdits,
      selected,
    ],
  )

  const openRow = useCallback(
    (row: Row) => {
      if (row.type === 'folder') {
        navigateToFolder(row.key)
        return
      }
      if (row.type === 'container') {
        setStatus({
          tone: 'info',
          text: "This HashFS archive can't be browsed. It may use an unsupported HashFS version or be protected by its author. Try Extract To; if that fails, OpenZip can't open this file.",
        })
        return
      }

      if (isNestedArchiveEntry(row.key)) {
        void openNestedArchive(row.key)
        return
      }

      if (isImageFile(row.key)) {
        void handleOpenImage(row.key)
        return
      }

      if (!isEditableFile(row.key)) {
        const extension = fileExtension(row.key)
        setStatus({
          tone: 'info',
          text: BINARY_EXTENSIONS.has(extension)
            ? `Binary game asset (.${extension}) — extract it to inspect or replace it.`
            : 'This file type cannot be opened in the built-in editor.',
        })
        return
      }

      void handleOpenFile(row.key)
    },
    [handleOpenFile, handleOpenImage, navigateToFolder, openNestedArchive],
  )

  /* ----- keyboard shortcuts ----- */

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (!event.ctrlKey && !event.metaKey) return
      const key = event.key.toLowerCase()
      if (key === 'o') {
        event.preventDefault()
        void handleOpenArchive()
      } else if (key === 'e') {
        event.preventDefault()
        void handleExtractTo()
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [handleExtractTo, handleOpenArchive])

  // Capture Ctrl+S before Monaco handles it so the archive is updated.
  useEffect(() => {
    if (!editingFile) return

    const onKeyDown = (event: KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's') {
        event.preventDefault()
        event.stopPropagation()
        void handleSaveFile()
      }
    }

    window.addEventListener('keydown', onKeyDown, true)
    return () => window.removeEventListener('keydown', onKeyDown, true)
  }, [editingFile, handleSaveFile])

  // Windows Explorer navigation shortcuts.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const key = event.key

      if (event.altKey && key === 'ArrowLeft') {
        event.preventDefault()
        handleNavigateBack()
        return
      }
      if (event.altKey && key === 'ArrowRight') {
        event.preventDefault()
        handleNavigateForward()
        return
      }
      if (event.altKey && key === 'ArrowUp') {
        event.preventDefault()
        handleNavigateUp()
        return
      }
      if (key === 'F5') {
        event.preventDefault()
        void refreshArchive()
        return
      }
      if (
        (event.ctrlKey || event.metaKey) &&
        key.toLowerCase() === 'a' &&
        archive &&
        !editingFile &&
        !imagePreview
      ) {
        const target = event.target as HTMLElement | null
        const isTextTarget = Boolean(
          target &&
            (target.tagName === 'INPUT' ||
              target.tagName === 'TEXTAREA' ||
              target.isContentEditable ||
              target.closest('.monaco-editor')),
        )
        if (!isTextTarget) {
          event.preventDefault()
          selectAllRef.current = true
          setSelected(new Set(rows.map((row) => row.key)))
          lastClickIndex.current = null
          setStatus({
            tone: 'info',
            text: `Selected ${rows.length} item${rows.length === 1 ? '' : 's'}`,
          })
          return
        }
      }
      if (key === 'Escape' && (editingFile || imagePreview)) {
        event.preventDefault()
        event.stopPropagation()
        handleNavigateBack()
        return
      }
      if (key === 'Backspace') {
        const target = event.target as HTMLElement | null
        const isTextTarget = Boolean(
          target &&
            (target.tagName === 'INPUT' ||
              target.tagName === 'TEXTAREA' ||
              target.isContentEditable ||
              target.closest('.monaco-editor')),
        )
        if (!isTextTarget) {
          event.preventDefault()
          handleNavigateBack()
        }
      }
    }

    window.addEventListener('keydown', onKeyDown, true)
    return () => window.removeEventListener('keydown', onKeyDown, true)
  }, [
    archive,
    editingFile,
    handleNavigateBack,
    handleNavigateForward,
    handleNavigateUp,
    imagePreview,
    refreshArchive,
    rows,
  ])

  /* ----- render helpers ----- */

  const crumbs = splitPath(currentPath)
  const isMacStyle = false
  const progressPercent = progress?.percent ?? null
  const extracting = busy === 'extracting' || busy === 'nested'
  const currentFolderSize = rows.reduce((sum, row) => sum + row.size, 0)
  const activeEditName = editingFile?.name ?? null
  const activeEditDirty = editingFile?.isDirty ?? false

  const currentItemLabel = (() => {
    if (!archive) return 'No archive open'
    if (editingFile) return baseName(editingFile.name)
    if (isScsContainer) return 'HashFS container'
    return currentPath ? `/${crumbs.join('/')}` : 'Archive root'
  })()

  return (
    <div
      className={`app${isMacStyle ? ' mac' : ''}`}
      data-theme={theme}
      onDragEnter={handleDragEnter}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
    >
      {/* Title strip */}
      <header className="titlebar">
        <div className="brand">
          <span className="brand-mark">
            <FileArchive size={16} strokeWidth={2.2} />
          </span>
          <span className="brand-name">OpenZip</span>
          <span className="brand-sub">archive manager</span>
          {appVersion && <span className="brand-version">{appVersion}</span>}
        </div>
        <div className="titlebar-right">
          {archive && (
            <span className={`format-pill${isScsContainer ? ' scs' : ''}`}>
              {isScsContainer ? 'HASHFS / SCS' : formatLabel(archive.format)}
            </span>
          )}
          {archive && <span className="title-file">{archive.fileName}</span>}
        </div>
      </header>

      {/* Toolbar */}
      <div className="toolbar" role="toolbar" aria-label="Archive actions">
        <button
          type="button"
          className="tool-btn primary"
          onClick={() => void handleOpenArchive()}
          disabled={busy !== null}
          title="Open Archive (Ctrl+O)"
        >
          <FolderOpen size={16} />
          <span>Open Archive</span>
        </button>
        <button
          type="button"
          className="tool-btn"
          onClick={() => void handleExtractTo()}
          disabled={!archive || busy !== null}
          title="Extract To (Ctrl+E)"
        >
          {extracting ? <Loader2 size={16} className="spin" /> : <Download size={16} />}
          <span>Extract To</span>
        </button>
        <button
          type="button"
          className="tool-btn"
          onClick={handleClose}
          disabled={!archive || busy !== null}
          title="Close archive"
        >
          <X size={16} />
          <span>Close</span>
        </button>

        <div className="toolbar-spacer" />

        <span className="toolbar-hint">
          {archive ? `${archive.entries.length.toLocaleString()} entries indexed` : 'No archive loaded'}
        </span>
      </div>

      {/* Explorer-style navigation + address bar */}
      <div className="addressbar">
        <div className="nav-controls" role="group" aria-label="Navigation">
          <button
            type="button"
            className="nav-btn"
            onClick={handleNavigateBack}
            disabled={!canNavigateBack}
            title="Back (Alt+Left / Backspace)"
            aria-label="Back"
          >
            <ArrowLeft size={16} />
          </button>
          <button
            type="button"
            className="nav-btn"
            onClick={handleNavigateForward}
            disabled={!canNavigateForward}
            title="Forward (Alt+Right)"
            aria-label="Forward"
          >
            <ArrowRight size={16} />
          </button>
          <button
            type="button"
            className="nav-btn"
            onClick={handleNavigateUp}
            disabled={!canNavigateUp}
            title="Up one level (Alt+Up)"
            aria-label="Up one level"
          >
            <ArrowUp size={16} />
          </button>
          <button
            type="button"
            className="nav-btn"
            onClick={() => void refreshArchive()}
            disabled={!archive || busy !== null}
            title="Refresh (F5)"
            aria-label="Refresh archive"
          >
            <RotateCw size={15} />
          </button>
        </div>

        <HardDrive size={15} className="address-icon" />
        <input
          className="address-input"
          type="text"
          readOnly
          spellCheck={false}
          value={
            archive
              ? archiveChainLabel
              : 'Open a .zip, .rar, .7z, .iso, .tar, .gz or .scs archive'
          }
          title={archive ? `${archiveChainLabel}\n${archive.filePath}` : undefined}
          aria-label="Current archive path"
        />
        {archive && (
          <span className="address-meta">
            {formatBytes(archive.fileSize)}
          </span>
        )}
      </div>

      {isNestedArchive && (
        <div
          className={`banner-warn ${
            nestedWriteBlocked ? 'nested-readonly' : 'nested-editable'
          }`}
        >
          <AlertCircle size={15} />
          <span>
            {nestedWriteBlocked
              ? nestedReadOnlyMessage
              : nestedModified
                ? `Modified — save changes to ${archive?.fileName ?? 'this archive'} inside ${
                    archiveStack[archiveStack.length - 1]?.archive.fileName ?? 'the outer archive'
                  } before leaving.`
                : `Editing inside ${archive?.fileName ?? 'this archive'}; changes are written back to the outer archive when you leave.`}
          </span>
        </div>
      )}

      {/* Folder breadcrumbs (hidden while editing) */}
      {!editingFile && (
        <div className="breadcrumbs">
        {archive && !isScsContainer ? (
          <>
            <button
              type="button"
              className={`crumb${currentPath ? '' : ' active'}`}
              onClick={() => navigateToFolder('')}
              disabled={busy !== null}
            >
              <PackageOpen size={13} />
              {archive.fileName}
            </button>
            {crumbs.map((crumb, index) => {
              const target = `${crumbs.slice(0, index + 1).join('/')}/`
              const isLast = index === crumbs.length - 1
              return (
                <span className="crumb-group" key={target}>
                  <ChevronRight size={13} className="crumb-sep" />
                  <button
                    type="button"
                    className={`crumb${isLast ? ' active' : ''}`}
                    onClick={() => navigateToFolder(target)}
                    disabled={busy !== null}
                  >
                    {crumb}
                  </button>
                </span>
              )
            })}
          </>
        ) : (
          <span className="breadcrumbs-empty">
            {archive
              ? isScsContainer
                ? 'Single HashFS container — extract to unpack all game assets.'
                : 'Archive root'
              : 'Nothing loaded'}
          </span>
        )}
        <div className="breadcrumbs-spacer" />
        <span className="breadcrumbs-count">
          {archive ? `${rows.length} item${rows.length === 1 ? '' : 's'}` : ''}
          {archive && !isScsContainer ? ` · ${formatBytes(currentFolderSize)}` : ''}
        </span>
        </div>
      )}

      {!bridgeReady && (
        <div className="banner-warn">
          <AlertCircle size={15} />
          <span>
            This page is not running inside Electron, so file dialogs are unavailable. Start the
            desktop app with <code>npm run electron:dev</code>.
          </span>
        </div>
      )}

      {/* File list / editor */}
      <main className={editingFile ? 'editor-panel' : 'list-panel'}>
        {editingFile ? (
          <>
            <div className="editor-topbar">
              <span className="editor-file-icon">
                <FileText size={15} />
              </span>
              <span className="editor-filename" title={editingFile.name}>
                {baseName(editingFile.name)}
              </span>
              {editingFile.isDirty && (
                <span className="editor-dirty" title="Unsaved changes">
                  *
                </span>
              )}
              {editingFile.name.includes('/') && (
                <span className="editor-path" title={editingFile.name}>
                  {editingFile.name}
                </span>
              )}
              <div className="editor-topbar-spacer" />
              <span className="editor-language">{editorLanguageLabel(editingFile.name)}</span>
              {isHashFsArchive && (
                <>
                  <button
                    type="button"
                    className="editor-btn mod-target"
                    onClick={() => void handleChangeScsModTarget()}
                    disabled={nestedWriteBlocked || isSavingFile || busy !== null}
                    title={
                      nestedWriteBlocked
                        ? nestedReadOnlyMessage
                        : scsModPath ?? 'Choose where edited files are saved'
                    }
                  >
                    <FolderOpen size={13} />
                    <span>{scsModPath ? baseName(scsModPath) : 'Mod target…'}</span>
                  </button>
                  <button
                    type="button"
                    className="editor-btn"
                    onClick={() => void handleRevertScsEdit()}
                    disabled={
                      nestedWriteBlocked ||
                      isSavingFile ||
                      (!editingFile.isDirty && scsEdits[editingFile.name] === undefined)
                    }
                    title={
                      nestedWriteBlocked
                        ? nestedReadOnlyMessage
                        : 'Revert this file to the original archive contents'
                    }
                  >
                    <RotateCcw size={13} />
                    <span>Revert</span>
                  </button>
                  <button
                    type="button"
                    className="editor-btn"
                    onClick={() => void handleSaveScsCopy()}
                    disabled={nestedWriteBlocked || isSavingFile || busy !== null}
                    title={
                      nestedWriteBlocked
                        ? nestedReadOnlyMessage
                        : 'Save a modified copy of the entire HashFS archive'
                    }
                  >
                    <FileOutput size={13} />
                    <span>Modified Copy…</span>
                  </button>
                </>
              )}
              <button
                type="button"
                className="editor-btn save"
                onClick={() => void handleSaveFile()}
                disabled={nestedWriteBlocked || isSavingFile || !editingFile.isDirty}
                title={
                  nestedWriteBlocked
                    ? nestedReadOnlyMessage
                    : isHashFsArchive
                      ? 'Save to Mod (Ctrl+S)'
                      : 'Save to Archive (Ctrl+S)'
                }
              >
                {isSavingFile ? <Loader2 size={14} className="spin" /> : <Save size={14} />}
                <span>
                  {isSavingFile ? 'Saving…' : isHashFsArchive ? 'Save to Mod' : 'Save to Archive'}
                </span>
              </button>
              <button
                type="button"
                className="editor-btn"
                onClick={handleCloseEditor}
                title="Close Editor"
              >
                <X size={14} />
                <span>Close Editor</span>
              </button>
            </div>

            <div className="editor-body">
              <Suspense
                fallback={
                  <div className="editor-loading">
                    <Loader2 size={18} className="spin" />
                    <span>Loading Monaco editor…</span>
                  </div>
                }
              >
                <EditorPane
                  fileName={editingFile.name}
                  content={editingFile.content}
                  language={editorLanguageFor(editingFile.name)}
                  darkMode={darkMode}
                  onChange={(value) =>
                    setEditingFile((current) =>
                      current ? { ...current, content: value, isDirty: true } : current,
                    )
                  }
                />
              </Suspense>
            </div>
          </>
        ) : !archive ? (
          <div className="empty-state">
            <div className="empty-icon">
              <FileArchive size={46} strokeWidth={1.3} />
            </div>
            <h1>No archive open</h1>
            <p>
              Open <strong>.zip</strong>, <strong>.rar</strong>, <strong>.7z</strong>,{' '}
              <strong>.tar</strong>, <strong>.gz</strong>, <strong>.iso</strong>,{' '}
              <strong>.cab</strong> and more — or an <strong>.scs</strong> HashFS container from Euro
              Truck Simulator 2 / American Truck Simulator.
            </p>
            <button
              type="button"
              className="empty-action"
              onClick={() => void handleOpenArchive()}
              disabled={busy !== null}
            >
              <FolderOpen size={16} />
              Open Archive…
            </button>
            <p className="empty-hint">
              RAR/7z/ISO/TAR/GZ/CAB are handled by the bundled 7-Zip engine; .scs by the bundled SCS
              extractor in <code>bin/</code>.
            </p>
          </div>
        ) : (
          <div className="table-wrap">
            <table className="file-table">
              <colgroup>
                <col />
                <col className="col-size" />
                <col className="col-size" />
                <col className="col-date" />
              </colgroup>
              <thead>
                <tr>
                  <th>
                    <button
                      type="button"
                      className="sort-btn"
                      onClick={() => toggleSort('name')}
                      aria-label="Sort by name"
                    >
                      Name
                      {sortKey === 'name' && <span className="caret">{sortDir === 1 ? '▲' : '▼'}</span>}
                    </button>
                  </th>
                  <th className="numeric">
                    <button
                      type="button"
                      className="sort-btn"
                      onClick={() => toggleSort('size')}
                      aria-label="Sort by size"
                    >
                      Size
                      {sortKey === 'size' && <span className="caret">{sortDir === 1 ? '▲' : '▼'}</span>}
                    </button>
                  </th>
                  <th className="numeric">
                    <button
                      type="button"
                      className="sort-btn"
                      onClick={() => toggleSort('packed')}
                      aria-label="Sort by packed size"
                    >
                      Packed Size
                      {sortKey === 'packed' && <span className="caret">{sortDir === 1 ? '▲' : '▼'}</span>}
                    </button>
                  </th>
                  <th>
                    <button
                      type="button"
                      className="sort-btn"
                      onClick={() => toggleSort('time')}
                      aria-label="Sort by modified date"
                    >
                      Modified Date
                      {sortKey === 'time' && <span className="caret">{sortDir === 1 ? '▲' : '▼'}</span>}
                    </button>
                  </th>
                </tr>
              </thead>
              <tbody>
                {currentPath && (
                  <tr className="row up-row" onDoubleClick={handleNavigateUp}>
                    <td className="cell-name" colSpan={4}>
                      <span className="row-icon folder">
                        <ArrowUp size={15} />
                      </span>
                      <span className="row-name">..</span>
                      <span className="row-note">Parent folder</span>
                    </td>
                  </tr>
                )}

                {rows.length === 0 && (
                  <tr className="row empty-row">
                    <td colSpan={4}>This folder is empty.</td>
                  </tr>
                )}

                {rows.map((row, index) => {
                  const isSelected = selected.has(row.key)
                  const rowIsImage = row.type === 'file' && isImageFile(row.key)
                  const rowIsEdited =
                    Boolean(scsEdits[row.key]) ||
                    Boolean(activeEditName === row.key && activeEditDirty)
                  return (
                    <tr
                      key={row.key}
                      className={`row${isSelected ? ' selected' : ''}${
                        row.type === 'folder' ? ' is-folder' : ''
                      }${rowIsEdited ? ' is-edited' : ''}`}
                      draggable={Boolean(archive) && !busy && row.type !== 'container'}
                      onDragStart={(event) => handleRowDragStart(event, row)}
                      onDragEnd={handleRowDragEnd}
                      onMouseDown={(event) => handleRowMouseDown(event, row)}
                      onClick={(event) => handleSelect(row, index, event)}
                      onDoubleClick={() => openRow(row)}
                      title={row.type === 'container' ? 'HashFS container' : row.key}
                    >
                      <td className="cell-name">
                        <span
                          className={`row-icon ${
                            row.type === 'folder'
                              ? 'folder'
                              : row.type === 'container'
                                ? 'container'
                                : rowIsImage
                                  ? 'image'
                                  : 'file'
                          }`}
                        >
                          {row.type === 'folder' ? (
                            <Folder size={15} />
                          ) : row.type === 'container' ? (
                            <PackageOpen size={15} />
                          ) : rowIsImage ? (
                            <ImageIcon size={15} />
                          ) : (
                            <FileIcon size={15} />
                          )}
                        </span>
                        <span className="row-name">{row.name}</span>
                        {row.type === 'folder' && <span className="row-note">Folder</span>}
                        {row.type === 'container' && <span className="row-note">HashFS archive</span>}
                        {rowIsImage && <span className="row-note">Image</span>}
                        {rowIsEdited && <span className="row-note edited">Edited</span>}
                      </td>
                      <td className="numeric cell-size">{formatBytes(row.size)}</td>
                      <td className="numeric cell-size muted">{formatBytes(row.packed)}</td>
                      <td className="cell-date">{formatDate(row.time)}</td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        )}
      </main>

      {/* Status bar */}
      <footer className={`statusbar${status.tone === 'error' ? ' has-error' : ''}`}>
        <div className="status-left">
          {status.tone === 'error' ? (
            <AlertCircle size={14} className="status-icon error" />
          ) : status.tone === 'success' ? (
            <CheckCircle2 size={14} className="status-icon success" />
          ) : (
            <Info size={14} className="status-icon" />
          )}
          <span className="status-text" title={status.text}>
            {status.text}
          </span>
        </div>

        <div className="status-right">
          {progress && (
            <div className={`progress${progressPercent === null ? ' indeterminate' : ''}`}>
              <span className="progress-label">
                {extracting && <Loader2 size={12} className="spin" />}
                {progressPercent !== null ? `${progressPercent}%` : 'working'}
              </span>
              <div className="progress-track">
                <div
                  className="progress-fill"
                  style={progressPercent !== null ? { width: `${progressPercent}%` } : undefined}
                />
              </div>
            </div>
          )}

          <span className="status-stat">
            {archive
              ? `${archive.stats.fileCount.toLocaleString()} file${
                  archive.stats.fileCount === 1 ? '' : 's'
                } · ${formatBytes(archive.stats.totalSize)}`
              : '0 files'}
          </span>
          <span className="status-stat dim">
            {selected.size > 0 ? `${selected.size} selected` : 'no selection'}
          </span>
          {scsEditedCount > 0 && (
            <span className="status-stat edited">{scsEditedCount} edited</span>
          )}
          <span className="status-stat dim">{currentItemLabel}</span>
        </div>
      </footer>

      <footer className="app-footer">
        <span className="footer-text">OpenZip is free</span>
        <span className="footer-sep" aria-hidden="true">
          ·
        </span>
        <a
          className="footer-link kofi"
          href={KOFI_URL}
          onClick={(event) => void handleExternalLink(event, KOFI_URL)}
          title="Support OpenZip on Ko-fi"
        >
          Support on Ko-fi
        </a>
        <span className="footer-sep" aria-hidden="true">
          ·
        </span>
        <a
          className="footer-link github"
          href={GITHUB_URL}
          onClick={(event) => void handleExternalLink(event, GITHUB_URL)}
          title="OpenZip on GitHub"
        >
          GitHub
        </a>
      </footer>

      {dragActive && (
        <div className="drop-overlay" aria-hidden="true">
          <div className="drop-card">
            <Upload size={36} />
            <span className="drop-title">Drop files to add them to the archive</span>
            <span className="drop-sub">
              or drop a .zip, .rar, .7z or .scs file to open it
            </span>
          </div>
        </div>
      )}

      {imagePreview && (
        <div
          className="image-modal-backdrop"
          role="presentation"
          onMouseDown={() => {
            handleNavigateBack()
          }}
        >
          <div
            className="image-modal"
            role="dialog"
            aria-modal="true"
            aria-label={`Image preview: ${baseName(imagePreview.name)}`}
            onMouseDown={(event) => event.stopPropagation()}
          >
            <div className="image-modal-header">
              <span className="image-modal-title">
                <ImageIcon size={15} />
                <span>{baseName(imagePreview.name)}</span>
              </span>
              <span className="image-modal-dims">
                {imageSize ? `${imageSize.width} × ${imageSize.height} px` : 'Loading…'}
              </span>
              <button
                type="button"
                className="editor-btn"
                onClick={() => {
                  handleNavigateBack()
                }}
              >
                <X size={14} />
                <span>Close</span>
              </button>
            </div>
            <div className="image-modal-body">
              <img
                src={imagePreview.dataUrl}
                alt={baseName(imagePreview.name)}
                onLoad={(event) =>
                  setImageSize({
                    width: event.currentTarget.naturalWidth,
                    height: event.currentTarget.naturalHeight,
                  })
                }
              />
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

export default App
