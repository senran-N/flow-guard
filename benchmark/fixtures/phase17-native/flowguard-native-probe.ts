import { invoke } from '@tauri-apps/api/core'
import { emit } from '@tauri-apps/api/event'
import { EditorState } from '@codemirror/state'
import { EditorView } from '@codemirror/view'
import { hostsHighlighter, boundaryLabels } from './components/Editor/hosts_cm'
;(window as any).__FLOWGUARD_PROBE__ = async (negative: boolean | string = false) => {
 const parent = document.createElement('div'); document.body.append(parent)
 const before = (window as any).__FLOWGUARD_TODOM__ || 0
 const view = new EditorView({ parent, state: EditorState.create({doc: '# --- SWITCHHOSTS_CONTENT_START ---\n127.0.0.1 localhost\n# --- SWITCHHOSTS_CONTENT_END ---', extensions: negative === 'widget' ? [] : [hostsHighlighter, boundaryLabels.of({start:'FG Start', end:'FG End'})]}) })
 await new Promise(resolve => setTimeout(resolve, 100))
 const labels = Array.from(parent.querySelectorAll('.swh-boundary-label')).map(n => n.textContent)
 const count = ((window as any).__FLOWGUARD_TODOM__ || 0) - before
 const pong = await invoke(negative === true ? 'flowguard_missing_command' : 'ping', {args: [], _args: []})
 await emit('main_window_ready', {})
 view.destroy(); parent.remove()
 if (pong !== 'pong' || count !== 2 || labels.join('|') !== 'FG Start|FG End') throw Error(JSON.stringify({pong,count,labels}))
 return {pong,count,labels,hasNativeInternals:!!(window as any).__TAURI_INTERNALS__}
}

;(window as any).__FLOWGUARD_EMIT_READY__ = () => emit('main_window_ready', {})
