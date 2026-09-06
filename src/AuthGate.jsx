import { useState } from "react";
import { useAction } from "convex/react";
import { api } from "../convex/_generated/api";
import { errText } from "./api.js";

export default function AuthGate({ onSignedIn }) {
  const requestCode = useAction(api.auth.requestCode);
  const verifyCode = useAction(api.auth.verifyCode);
  const [step, setStep] = useState(1);
  const [email, setEmail] = useState("");
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");

  const sendCode = async () => {
    const e = email.trim();
    if (!e) return setErr("Enter your email.");
    setBusy(true);
    setErr("");
    try {
      await requestCode({ email: e });
      setStep(2);
      setCode("");
    } catch (ex) {
      setErr(errText(ex, "Couldn't send the code — check the email and try again."));
    } finally {
      setBusy(false);
    }
  };

  const verify = async () => {
    const c = code.trim();
    if (!c) return setErr("Enter the 6-digit code.");
    setBusy(true);
    setErr("");
    try {
      const r = await verifyCode({ email: email.trim(), code: c });
      onSignedIn(r.token);
    } catch (ex) {
      setErr(errText(ex, "That code didn't work — try again."));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="sb-center">
      <div className="auth-card">
        <h1>✎ Sketchboard</h1>
        <p className="auth-sub">Draw together with Claude. Invite-only: sign in with your email.</p>
        {step === 1 ? (
          <>
            <label htmlFor="authEmail">Email</label>
            <input
              id="authEmail"
              type="email"
              autoComplete="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && sendCode()}
              autoFocus
            />
            <button className="primary" onClick={sendCode} disabled={busy}>
              {busy ? "Sending…" : "Email me a code"}
            </button>
          </>
        ) : (
          <>
            <p className="auth-sub">
              We sent a 6-digit code to <b>{email.trim()}</b>. It expires in 10 minutes.
            </p>
            <label htmlFor="authCode">Code</label>
            <input
              id="authCode"
              inputMode="numeric"
              autoComplete="one-time-code"
              value={code}
              onChange={(e) => setCode(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && verify()}
              autoFocus
            />
            <button className="primary" onClick={verify} disabled={busy}>
              {busy ? "Checking…" : "Sign in"}
            </button>
            <button className="link" onClick={() => setStep(1)} disabled={busy}>
              Use a different email
            </button>
          </>
        )}
        {err && <div className="auth-err">{err}</div>}
      </div>
    </div>
  );
}
