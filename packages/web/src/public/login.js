// SPDX-License-Identifier: GPL-3.0-only
// Copyright (c) 2026 Jeff Moore

// Talaris's sign-in page (auth.mjs): a passkey to sign in; a one-time code and a passkey to add one.
(() => {
  const { startAuthentication, startRegistration } = window.SimpleWebAuthnBrowser;
  const $ = (id) => document.getElementById(id);
  const prefix = location.pathname.replace(/\/login$/, "");
  const then = new URLSearchParams(location.search).get("then");
  const say = (text, bad = false) => { $("say").textContent = text; $("say").classList.toggle("bad", bad); };

  async function post(path, body) {
    const r = await fetch(`${prefix}${path}`, { method: "POST", credentials: "same-origin",
      headers: { "content-type": "application/json", "x-talaris": "1" }, body: JSON.stringify(body || {}) });
    const data = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(data.error || `It answered ${r.status}`);
    return data;
  }
  const into = () => { location.href = then && then.startsWith(prefix) ? then : `${prefix}/`; };

  $("go").addEventListener("click", async () => {
    try {
      say("Asking for your passkey…");
      const { options, hold } = await post("/auth/signin/options");
      const response = await startAuthentication({ optionsJSON: options });
      await post("/auth/signin", { hold, response });
      into();
    } catch (e) { say(e.name === "NotAllowedError" ? "Not signed in." : e.message, true); }
  });

  $("add-go").addEventListener("click", async () => {
    try {
      say("Checking the code…");
      const { options, hold } = await post("/auth/register/options", { code: $("code").value });
      say("Making the passkey…");
      const response = await startRegistration({ optionsJSON: options });
      await post("/auth/register", { hold, response, name: $("name").value || navigator.platform || "A passkey" });
      say("Added. Sign in with it now.");
      $("add").hidden = true; $("signin").hidden = false;
    } catch (e) { say(e.name === "NotAllowedError" ? "No passkey was made." : e.message, true); }
  });

  $("to-add").addEventListener("click", () => { $("signin").hidden = true; $("add").hidden = false; say(""); $("code").focus(); });
  $("to-signin").addEventListener("click", () => { $("add").hidden = true; $("signin").hidden = false; say(""); });
})();
