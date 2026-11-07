import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  AlertCircle,
  ArrowUp,
  CheckCircle2,
  ChevronRight,
  Download,
  File as FileIcon,
  FileArchive,
  FileText,
  Folder,
  FolderOpen,
  HardDrive,
  Image as ImageIcon,
  Info,
  Loader2,
  PackageOpen,
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
type BusyState = 'reading' | 'adding' | 'extracting' | null
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

interface EditingFile {
  name: string
  content: string
  isDirty: boolean
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
  const parts = path.split('/')
  return parts[parts.length - 1] || path
}

function fileExtension(path: string): string {
  const name = baseName(path)
  const dot = name.lastIndexOf('.')
  return dot < 0 ? '' : name.slice(dot + 1).toLowerCase()
}

const IMAGE_EXTENSIONS = new Set(['png', 'jpg', 'jpeg', 'bmp', 'webp', 'ico', 'gif'])

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
  const [imagePreview, setImagePreview] = useState<ImagePreview | null>(null)
  const [imageSize, setImageSize] = useState<{ width: number; height: number } | null>(null)
  const [dragActive, setDragActive] = useState(false)
  const theme = darkMode ? 'dark' : 'light'

  const ipcRef = useRef<IpcRendererLike | null>(getIpc())
  const lastClickIndex = useRef<number | null>(null)
  const dragDepth = useRef(0)

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

  /* ----- actions ----- */

  const resetState = useCallback(() => {
    setCurrentPath('')
    setSelected(new Set())
    setProgress(null)
  }, [])

  const loadArchive = useCallback(
    async (filePath: string) => {
      const ipc = ipcRef.current
      if (!ipc) return

      setEditingFile(null)
      setImagePreview(null)
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
    [resetState],
  )

  const handleOpenArchive = useCallback(async () => {
    const ipc = ipcRef.current
    if (!ipc || busy) return

    const picked = (await ipc.invoke('dialog:openArchive')) as OpenResult
    if (!picked || picked.canceled || !picked.filePath) return

    if (editingFile?.isDirty && !window.confirm('Discard unsaved changes?')) return
    await loadArchive(picked.filePath)
  }, [busy, editingFile, loadArchive])

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
    if (busy) return
    if (editingFile?.isDirty && !window.confirm('Discard unsaved changes?')) return
    setEditingFile(null)
    setImagePreview(null)
    setArchive(null)
    resetState()
    setStatus({ tone: 'info', text: 'Archive closed' })
  }, [busy, editingFile, resetState])

  const handleCloseEditor = useCallback(() => {
    if (!editingFile) return
    if (editingFile.isDirty && !window.confirm('Discard unsaved changes?')) return
    setEditingFile(null)
    setStatus({ tone: 'info', text: 'Editor closed' })
  }, [editingFile])

  const handleOpenImage = useCallback(
    async (entryName: string) => {
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
    [archive, busy],
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

      if (paths.length === 1 && isArchiveFile(paths[0])) {
        if (editingFile?.isDirty && !window.confirm('Discard unsaved changes?')) return
        await loadArchive(paths[0])
        return
      }

      if (!archive) {
        setStatus({ tone: 'info', text: 'Open an archive before adding files.' })
        return
      }

      const isContainer =
        archive.entries.length === 1 && archive.entries[0].kind === 'container'
      const writable = archive.format === 'zip' || archive.format === '7z' || archive.format === 'tar'
      if (isContainer || !writable) {
        setStatus({ tone: 'error', text: 'This archive format is read-only. Cannot inject files.' })
        return
      }

      if (!window.confirm(`Add ${paths.length} item(s) to archive?`)) return

      const ipc = ipcRef.current
      if (!ipc) return

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
    [archive, busy, currentPath, editingFile, loadArchive, refreshArchiveEntries],
  )

  const handleDragEnter = useCallback((event: React.DragEvent<HTMLDivElement>) => {
    event.preventDefault()
    dragDepth.current += 1
    setDragActive(true)
  }, [])

  const handleDragOver = useCallback((event: React.DragEvent<HTMLDivElement>) => {
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
    async (entryName: string) => {
      const ipc = ipcRef.current
      if (!ipc || !archive || busy) return

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
        setStatus({
          tone: 'info',
          text: `Editing ${baseName(entryName)} — Ctrl+S saves to the archive`,
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
    [archive, busy],
  )

  const handleSaveFile = useCallback(async () => {
    const ipc = ipcRef.current
    if (!ipc || !archive || !editingFile || isSavingFile) return

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
  }, [archive, editingFile, isSavingFile])

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

  const openRow = useCallback(
    (row: Row) => {
      if (row.type === 'folder') {
        setCurrentPath(row.key)
        setSelected(new Set())
        lastClickIndex.current = null
        return
      }
      if (row.type === 'container') {
        setStatus({
          tone: 'info',
          text: 'HashFS .scs containers are read-only. Extract files to edit them.',
        })
        return
      }

      if (isImageFile(row.key)) {
        void handleOpenImage(row.key)
        return
      }

      if (!isEditableFile(row.key)) {
        setStatus({
          tone: 'info',
          text: 'This file type cannot be opened in the built-in editor.',
        })
        return
      }

      void handleOpenFile(row.key)
    },
    [handleOpenFile, handleOpenImage],
  )

  const goUp = useCallback(() => {
    if (!currentPath) return
    setCurrentPath(parentPath(currentPath))
    setSelected(new Set())
    lastClickIndex.current = null
  }, [currentPath])

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

  // Esc closes the image viewer.
  useEffect(() => {
    if (!imagePreview) return

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault()
        setImagePreview(null)
        setStatus({ tone: 'info', text: 'Image closed' })
      }
    }

    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [imagePreview])

  /* ----- render helpers ----- */

  const crumbs = splitPath(currentPath)
  const isMacStyle = false
  const progressPercent = progress?.percent ?? null
  const extracting = busy === 'extracting'
  const currentFolderSize = rows.reduce((sum, row) => sum + row.size, 0)

  const isScsContainer = Boolean(
    archive && archive.entries.length === 1 && archive.entries[0].kind === 'container',
  )

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

        <div className="toolbar-sep" />

        <button
          type="button"
          className="tool-btn icon-only"
          onClick={goUp}
          disabled={!archive || !currentPath || busy !== null}
          title="Up one level"
          aria-label="Up one level"
        >
          <ArrowUp size={16} />
        </button>

        <div className="toolbar-spacer" />

        <span className="toolbar-hint">
          {archive ? `${archive.entries.length.toLocaleString()} entries indexed` : 'No archive loaded'}
        </span>
      </div>

      {/* Address bar */}
      <div className="addressbar">
        <HardDrive size={15} className="address-icon" />
        <input
          className="address-input"
          type="text"
          readOnly
          spellCheck={false}
          value={archive ? archive.filePath : 'Open a .zip, .rar, .7z, .iso, .tar, .gz or .scs archive'}
          title={archive ? archive.filePath : undefined}
          aria-label="Current archive path"
        />
        {archive && (
          <span className="address-meta">
            {formatBytes(archive.fileSize)}
          </span>
        )}
      </div>

      {/* Folder breadcrumbs (hidden while editing) */}
      {!editingFile && (
        <div className="breadcrumbs">
        {archive && !isScsContainer ? (
          <>
            <button
              type="button"
              className={`crumb${currentPath ? '' : ' active'}`}
              onClick={() => {
                setCurrentPath('')
                setSelected(new Set())
              }}
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
                    onClick={() => {
                      setCurrentPath(target)
                      setSelected(new Set())
                    }}
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
              <button
                type="button"
                className="editor-btn save"
                onClick={() => void handleSaveFile()}
                disabled={isSavingFile || !editingFile.isDirty}
                title="Save to Archive (Ctrl+S)"
              >
                {isSavingFile ? <Loader2 size={14} className="spin" /> : <Save size={14} />}
                <span>{isSavingFile ? 'Saving…' : 'Save to Archive'}</span>
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
                  <tr className="row up-row" onDoubleClick={goUp}>
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
                  return (
                    <tr
                      key={row.key}
                      className={`row${isSelected ? ' selected' : ''}${
                        row.type === 'folder' ? ' is-folder' : ''
                      }`}
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
            setImagePreview(null)
            setStatus({ tone: 'info', text: 'Image closed' })
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
                  setImagePreview(null)
                  setStatus({ tone: 'info', text: 'Image closed' })
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
