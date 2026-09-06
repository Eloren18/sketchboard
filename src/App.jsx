import { useCallback, useEffect, useRef, useState } from "react";
import { useMutation, useQuery } from "convex/react";
import { api } from "../convex/_generated/api";
import { errText, getLastSketch, getToken, setLastSketch, setToken } from "./api.js";
import AuthGate from "./AuthGate.jsx";
import Board from "./Board.jsx";
import ChatPanel from "./ChatPanel.jsx";

export default function App() {
  const [token, setTok] = useState(getToken);
  const me = useQuery(api.auth.me, token ? { token } : "skip");
  const signOut = useMutation(api.auth.signOut);

  useEffect(() => {
    // Stored token is expired or revoked: back to the sign-in screen.
    if (token && me === null) {
      setToken("");
      setTok("");
    }
  }, [token, me]);

  const onSignedIn = useCallback((t) => {
    setToken(t);
    setTok(t);
  }, []);

  const onSignOut = useCallback(async () => {
    if (!window.confirm(`Sign out of ${me?.email}?\n\nYour sketches stay in the cloud.`)) return;
    signOut({ token }).catch(() => {});
    setToken("");
    setLastSketch("");
    setTok("");
  }, [token, me, signOut]);

  if (!token) return <AuthGate onSignedIn={onSignedIn} />;
  if (me === undefined) return <div className="sb-center">Signing in…</div>;
  if (!me) return <AuthGate onSignedIn={onSignedIn} />;
  return <Workspace token={token} me={me} onSignOut={onSignOut} />;
}

function Workspace({ token, me, onSignOut }) {
  const sketches = useQuery(api.sketches.list, { token });
  const create = useMutation(api.sketches.create);
  const rename = useMutation(api.sketches.rename);
  const remove = useMutation(api.sketches.remove);
  const [currentId, setCurrentId] = useState(getLastSketch);
  const [chatOpen, setChatOpen] = useState(() => {
    try {
      return localStorage.getItem("sketchboard.chatOpen") !== "0";
    } catch {
      return true;
    }
  });
  const creating = useRef(false);

  useEffect(() => {
    try {
      localStorage.setItem("sketchboard.chatOpen", chatOpen ? "1" : "0");
    } catch {}
  }, [chatOpen]);

  // Pick a sketch: the last one used, else the newest, else create the first.
  useEffect(() => {
    if (!sketches) return;
    if (sketches.some((s) => s.id === currentId)) return;
    if (sketches.length) {
      setCurrentId(sketches[0].id);
      setLastSketch(sketches[0].id);
      return;
    }
    if (creating.current) return;
    creating.current = true;
    create({ token, title: "My first sketch" })
      .then((id) => {
        setCurrentId(id);
        setLastSketch(id);
      })
      .catch((e) => window.alert(errText(e)))
      .finally(() => (creating.current = false));
  }, [sketches, currentId, create, token]);

  const current = sketches?.find((s) => s.id === currentId) || null;

  const choose = (id) => {
    setCurrentId(id);
    setLastSketch(id);
  };
  const onNew = async () => {
    const title = window.prompt("Name for the new sketch:", "Untitled sketch");
    if (title === null) return;
    try {
      const id = await create({ token, title });
      choose(id);
    } catch (e) {
      window.alert(errText(e));
    }
  };
  const onRename = async () => {
    if (!current) return;
    const title = window.prompt("Rename sketch:", current.title);
    if (title === null || !title.trim()) return;
    try {
      await rename({ token, id: current.id, title });
    } catch (e) {
      window.alert(errText(e));
    }
  };
  const onDelete = async () => {
    if (!current) return;
    if (!window.confirm(`Delete "${current.title}" and its chat? This cannot be undone.`)) return;
    try {
      await remove({ token, id: current.id });
      setCurrentId("");
      setLastSketch("");
    } catch (e) {
      window.alert(errText(e));
    }
  };

  return (
    <div className="sb-app">
      <header className="sb-header">
        <span className="sb-brand">✎ Sketchboard</span>
        <select
          className="sb-select"
          value={current ? current.id : ""}
          onChange={(e) => choose(e.target.value)}
          disabled={!sketches?.length}
          title="Switch sketch"
        >
          {(sketches || []).map((s) => (
            <option key={s.id} value={s.id}>
              {s.title}
            </option>
          ))}
        </select>
        <button onClick={onNew}>New</button>
        <button onClick={onRename} disabled={!current}>
          Rename
        </button>
        <button onClick={onDelete} disabled={!current} className="danger">
          Delete
        </button>
        <span className="sb-spacer" />
        <button onClick={() => setChatOpen((v) => !v)}>{chatOpen ? "Hide chat" : "Show chat"}</button>
        <span className="sb-user" title={me.email}>
          {me.email}
        </span>
        <button onClick={onSignOut}>Sign out</button>
      </header>
      <div className="sb-body">
        <div className="sb-board">
          {current ? <Board key={current.id} token={token} id={current.id} /> : <div className="sb-center">Loading sketch…</div>}
        </div>
        {chatOpen && current && <ChatPanel key={current.id} token={token} sketchId={current.id} />}
      </div>
    </div>
  );
}
