import Editor, { loader } from '@monaco-editor/react'
import * as monaco from 'monaco-editor'
import EditorWorker from 'monaco-editor/editor/editor.worker.js?worker'
import CssWorker from 'monaco-editor/language/css/css.worker.js?worker'
import HtmlWorker from 'monaco-editor/language/html/html.worker.js?worker'
import JsonWorker from 'monaco-editor/language/json/json.worker.js?worker'
import TsWorker from 'monaco-editor/language/typescript/ts.worker.js?worker'

// Use the bundled Monaco build instead of @monaco-editor/react's CDN loader so
// the editor works offline inside Electron.
loader.config({ monaco })

// @monaco-editor/react's theme prop expects "light"; Monaco ships "vs".
monaco.editor.defineTheme('light', {
  base: 'vs',
  inherit: true,
  rules: [],
  colors: {
    'editor.background': '#ffffff',
  },
})

interface MonacoWorkerScope {
  MonacoEnvironment?: {
    getWorker: (moduleId: string, label: string) => Worker
  }
}

const workerScope = self as unknown as MonacoWorkerScope
workerScope.MonacoEnvironment = {
  getWorker(_moduleId, label) {
    switch (label) {
      case 'json':
        return new JsonWorker()
      case 'css':
      case 'scss':
      case 'less':
        return new CssWorker()
      case 'html':
      case 'handlebars':
      case 'razor':
        return new HtmlWorker()
      case 'typescript':
      case 'javascript':
        return new TsWorker()
      default:
        return new EditorWorker()
    }
  },
}

const EDITOR_OPTIONS: monaco.editor.IStandaloneEditorConstructionOptions = {
  automaticLayout: true,
  minimap: { enabled: false },
  fontSize: 13,
  lineHeight: 20,
  fontFamily: "'Cascadia Code', Consolas, 'Courier New', monospace",
  wordWrap: 'on',
  scrollBeyondLastLine: false,
  tabSize: 2,
  insertSpaces: true,
  renderWhitespace: 'selection',
  smoothScrolling: true,
  padding: { top: 8, bottom: 8 },
}

export interface EditorPaneProps {
  fileName: string
  content: string
  language: string
  darkMode: boolean
  onChange: (value: string) => void
}

export default function EditorPane({
  fileName,
  content,
  language,
  darkMode,
  onChange,
}: EditorPaneProps) {
  return (
    <Editor
      height="100%"
      path={fileName}
      language={language}
      theme={darkMode ? 'vs-dark' : 'light'}
      value={content}
      onChange={(value) => onChange(value ?? '')}
      options={EDITOR_OPTIONS}
      loading={<div className="editor-loading">Loading Monaco editor…</div>}
    />
  )
}
