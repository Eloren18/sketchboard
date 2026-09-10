import { useEffect, useRef, useState } from "react";
import { useMutation, useQuery } from "convex/react";
import { api } from "../convex/_generated/api";
import { errText } from "./api.js";

// Minimal formatting: paragraphs, inline code, bold, fenced code.
function RichText({ text }) {
  const chunks = text.split(/(```[\s\S]*?```)/g);
  return chunks.map((chunk, i) => {
    if (chunk.startsWith("```")) {
      const body = chunk.replace(/^```[^\n]*\n?/, "").replace(/```$/, "");
      return (
        <pre key={i}>
          <code>{body}</code>
        </pre>
      );
    }
    const parts = chunk.split(/(`[^`]+`|\*\*[^*]+\*\*)/g);
    return (
      <span key={i}>
        {parts.map((p, j) => {
          if (p.startsWith("`") && p.endsWith("`")) return <code key={j}>{p.slice(1, -1)}</code>;
          if (p.startsWith("**") && p.endsWith("**")) return <strong key={j}>{p.slice(2, -2)}</strong>;
          return p;
        })}
      </span>
    );
  });
}

function parseParts(m) {
  try {
    const parts = JSON.parse(m.parts || "[]");
    if (Array.isArray(parts) && parts.length) return parts;
  } catch {}
  return m.text ? [{ kind: "text", text: m.text }] : [];
}

function Message({ msg }) {
  const parts = parseParts(msg);
  return (
    <div className={`chat-msg ${msg.role}`}>
      {parts.map((part, i) =>
        part.kind === "tool" ? (
          <div key={i} className="chat-tool">
            {part.label}
          </div>
        ) : (
          <div key={i} className="chat-text">
            <RichText text={part.text} />
          </div>
        ),
      )}
      {msg.error && <div className="chat-error">{msg.error}</div>}
      {msg.status === "streaming" && !parts.length && <div className="chat-thinking">thinking…</div>}
    </div>
  );
}

export default function ChatPanel({ token, sketchId }) {
  const messages = useQuery(api.chat.list, { token, sketchId });
  const send = useMutation(api.chat.send);
  const stop = useMutation(api.chat.stop);
  const reset = useMutation(api.chat.reset);
  const [input, setInput] = useState("");
  const [err, setErr] = useState("");
  const listRef = useRef(null);
  const inputRef = useRef(null);

  // A reply still "streaming" after 10 minutes is dead (the server treats it the
  // same way): do not let it keep the panel locked.
  const STALE_MS = 10 * 60 * 1000;
  const streaming = !!messages?.some((m) => m.status === "streaming" && Date.now() - m.createdAt < STALE_MS);

  useEffect(() => {
    const el = listRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages]);

  const onSend = async () => {
    const text = input.trim();
    if (!text || streaming) return;
    setErr("");
    setInput("");
    try {
      await send({ token, sketchId, text });
    } catch (e) {
      setErr(errText(e));
      setInput(text);
    }
    inputRef.current?.focus();
  };

  const onReset = async () => {
    if (streaming) return;
    if (!window.confirm("Start a new chat? The assistant forgets this conversation (the sketch stays).")) return;
    try {
      await reset({ token, sketchId });
    } catch (e) {
      setErr(errText(e));
    }
  };

  const onKeyDown = (e) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      onSend();
    }
  };

  return (
    <aside className="chat-panel">
      <header className="chat-header">
        <span className="chat-title">Claude</span>
        <span className="chat-header-actions">
          <button onClick={onReset} disabled={streaming || !messages?.length} title="New conversation">
            New chat
          </button>
        </span>
      </header>
      <div className="chat-list" ref={listRef}>
        {messages === undefined && <div className="chat-empty">Loading…</div>}
        {messages && messages.length === 0 && (
          <div className="chat-empty">
            Ask me to look at the sketch, add or move things, or label what you drew.
            <br />
            <br />
            Try: “What do you see?” or “Add a box labelled Retailer to the right of the yellow one.”
          </div>
        )}
        {(messages || []).map((m) => (
          <Message key={m.id} msg={m} />
        ))}
        {err && <div className="chat-error">{err}</div>}
      </div>
      <div className="chat-compose">
        <textarea
          ref={inputRef}
          value={input}
          placeholder="Message… (Enter to send, Shift+Enter for newline)"
          rows={2}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={onKeyDown}
        />
        {streaming ? (
          <button className="chat-stop" onClick={() => stop({ token, sketchId }).catch(() => {})}>
            Stop
          </button>
        ) : (
          <button className="chat-send" onClick={onSend} disabled={!input.trim()}>
            Send
          </button>
        )}
      </div>
    </aside>
  );
}
