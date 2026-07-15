import { useEffect, useRef, useState } from 'react'
import { C, css, lc, MONO } from '../theme'
import { useStore } from '../store'

const SUGGESTIONS = ['What database do we use?', 'How do we handle on-call?']
const MCP_CONFIG_CMD = 'claude mcp add contextcake -- node mcp-server.mjs --manifest layers.json'

export function ChatPanel() {
  const { chatMessages, chatBusy, chatInput, setChatInput, closeChat, send } = useStore()
  const scrollRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLTextAreaElement>(null)
  const [copied, setCopied] = useState<'idle' | 'copied' | 'failed'>('idle')
  const copyTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)

  const copyMcpConfig = () => {
    const settle = (state: 'copied' | 'failed') => {
      setCopied(state)
      clearTimeout(copyTimer.current)
      copyTimer.current = setTimeout(() => setCopied('idle'), 2000)
    }
    if (!navigator.clipboard || !window.isSecureContext) {
      // Insecure context (e.g. LAN http://) — no async clipboard. Show the
      // command pre-selected in a prompt so a manual ⌘/Ctrl-C still works.
      window.prompt('Copy the MCP config command:', MCP_CONFIG_CMD)
      return
    }
    navigator.clipboard.writeText(MCP_CONFIG_CMD)
      .then(() => settle('copied'))
      .catch(() => settle('failed'))
  }

  useEffect(() => () => clearTimeout(copyTimer.current), [])

  useEffect(() => {
    const el = scrollRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [chatMessages, chatBusy])

  // Focus the composer on open, and let Escape close the panel.
  useEffect(() => {
    inputRef.current?.focus()
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') closeChat() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [closeChat])

  return (
    <div>
      <div onClick={closeChat} style={css('position:fixed; inset:0; background:rgba(26,25,21,0.28); z-index:40;')} />
      <aside role="dialog" aria-modal="true" aria-label="Ask ContextCake" style={css('position:fixed; top:0; right:0; height:100vh; width:412px; z-index:41; display:flex; flex-direction:column; background:#FBFAF6; border-left:1px solid #C3C1B8; box-shadow:-24px 0 60px rgba(26,25,21,0.14); animation:ccSlide 0.26s cubic-bezier(0.16,1,0.3,1);')}>
        <header style={css('display:flex; align-items:center; gap:11px; padding:16px 18px; border-bottom:1px solid #D8D6CC;')}>
          <div style={css('display:grid; place-items:center; width:30px; height:30px; border-radius:8px; background:#134F49;')}>
            <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="#EAF7F5" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M12 3l1.8 4.9L18.7 9.7l-4.9 1.8L12 16.4l-1.8-4.9L5.3 9.7l4.9-1.8z" /></svg>
          </div>
          <div style={css('flex:1; line-height:1.2;')}>
            <div style={css('font-weight:600; font-size:14px;')}>Ask ContextCake</div>
            <div style={css('font-size:11px; color:#8A8A82;')}>Answers from your resolved cascade</div>
          </div>
          <button
            className="cc-h-eae"
            onClick={copyMcpConfig}
            title="Copy the command to connect a real agent"
            style={css(`display:flex; align-items:center; gap:6px; padding:6px 10px; border:1px solid ${C.line}; background:transparent; border-radius:7px; cursor:pointer; font:inherit; font-family:${MONO}; font-size:10.5px; color:${C.caption};`)}
          >
            {copied === 'copied' ? 'Copied' : copied === 'failed' ? 'Copy failed' : 'Copy MCP config'}
          </button>
          <button className="cc-h-eae" onClick={closeChat} aria-label="Close chat" style={css('display:grid; place-items:center; width:30px; height:30px; border:none; background:transparent; border-radius:7px; cursor:pointer; color:#57564F;')}>
            <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M6 6l12 12M18 6L6 18" /></svg>
          </button>
        </header>

        <div ref={scrollRef} style={css('flex:1; overflow-y:auto; padding:18px; display:flex; flex-direction:column; gap:16px;')}>
          {chatMessages.map((m, i) => {
            const isUser = m.role === 'user'
            return (
              <div key={i} style={css(`display:flex; ${isUser ? 'justify-content:flex-end;' : ''}`)}>
                <div style={css(`max-width:88%; padding:12px 14px; border-radius:13px; ${isUser ? 'background:#1E6B64; border-bottom-right-radius:4px;' : `background:#FFFFFF; border:1px solid ${C.line}; border-bottom-left-radius:4px;`}`)}>
                  {m.intro && <div style={css('font-size:12px; font-weight:600; letter-spacing:0.05em; text-transform:uppercase; color:#8A8A82; margin-bottom:6px;')}>ContextCake</div>}
                  <div style={css(`font-size:13.5px; line-height:1.55; color:${isUser ? 'var(--cc-on-teal)' : C.body}; white-space:pre-wrap;`)}>{m.text}</div>
                  {m.cites && m.cites.length > 0 && (
                    <div style={css('display:flex; flex-wrap:wrap; gap:6px; margin-top:11px;')}>
                      {m.cites.map((ci, j) => {
                        const col = lc(ci.layer)
                        return (
                          <span key={j} style={css(`display:inline-flex; align-items:center; font-family:${MONO}; font-size:10.5px; font-weight:500; padding:4px 9px; border-radius:999px; background:${col.fill}; color:${col.text}; border:1px solid ${col.strokeE};`)}>
                            <span style={css(`display:inline-block; width:6px; height:6px; border-radius:999px; margin-right:6px; background:${col.strokeE};`)} />{ci.label}
                          </span>
                        )
                      })}
                    </div>
                  )}
                  {m.note && (
                    <div style={css('margin-top:9px; padding-top:9px; border-top:1px solid #EAE7DD; font-size:11.5px; color:#7A5A28; line-height:1.45;')}>{m.note}</div>
                  )}
                  {m.canned && (
                    <div style={css(`margin-top:9px; padding-top:9px; border-top:1px solid #EAE7DD; font-family:${MONO}; font-size:10.5px; color:#8A8A82; letter-spacing:0.01em;`)}>Sample answer — connect an agent (Copy MCP config) for real ones</div>
                  )}
                </div>
              </div>
            )
          })}
          {chatBusy && (
            <div style={css('display:flex; align-items:center; gap:7px; padding:2px 4px;')}>
              <span style={css('width:7px; height:7px; border-radius:999px; background:#2C8A82; animation:ccPulse 1s ease-in-out infinite;')} />
              <span style={css('font-size:12px; color:#8A8A82;')}>resolving cascade…</span>
            </div>
          )}
        </div>

        <div style={css('padding:14px 16px; border-top:1px solid #D8D6CC;')}>
          <div style={css('display:flex; flex-wrap:wrap; gap:6px; margin-bottom:10px;')}>
            {SUGGESTIONS.map((t) => (
              <button key={t} className="cc-h-bluefill2" onClick={() => send(t)} style={css('font:inherit; font-size:11.5px; color:#3D6E9E; background:#EAF3FC; border:1px solid #C6DEF6; border-radius:999px; padding:5px 11px; cursor:pointer;')}>{t}</button>
            ))}
          </div>
          <div style={css('display:flex; align-items:flex-end; gap:8px; background:#FFFFFF; border:1px solid #C3C1B8; border-radius:11px; padding:8px 8px 8px 12px;')}>
            <textarea
              ref={inputRef}
              value={chatInput}
              aria-label="Ask about your team's knowledge"
              onChange={(e) => setChatInput(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send() } }}
              rows={1}
              placeholder="Ask about your team's knowledge…"
              style={css("flex:1; border:none; outline:none; resize:none; font:inherit; font-size:13.5px; line-height:1.5; background:transparent; color:#1A1915; max-height:120px;")}
            />
            <button className="cc-h-tealdark" onClick={() => send()} aria-label="Send message" style={css('display:grid; place-items:center; width:34px; height:34px; border:none; border-radius:8px; background:#1E6B64; color:var(--cc-on-teal); cursor:pointer; flex:0 0 auto;')}>
              <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M5 12h13M12 5l7 7-7 7" /></svg>
            </button>
          </div>
        </div>
      </aside>
    </div>
  )
}
