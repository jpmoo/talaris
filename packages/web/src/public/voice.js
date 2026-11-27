// SPDX-License-Identifier: GPL-3.0-only
// Copyright (c) 2026 Jeff Moore

/*
 * Morgan's voice on the web (docs/WEB.md, *Morgan's voice on the web*): the conversation page's microphone, in a
 * browser. Loaded on Morgan's page only, after the page; the page itself is the desktop's, unchanged.
 *
 * - **Press to talk.** A tap on the microphone starts listening and a second tap sends; held down, it sends when let
 *   go. Nothing listens otherwise — the microphone is taken for each turn and given back after it, so a phone shows it
 *   in use only then (and an iPhone plays Morgan through its speaker, not its earpiece, as it does while a microphone
 *   is open). Pressed while Morgan works or speaks, it stops, as on the desktop.
 * - What was said is sent to the web side (`/api/morgan/hear`) as the browser recorded it, made words there by
 *   Morgan's speech service, and sent as a turn spoken (`say`), so Morgan answers as it does aloud: short and plain.
 * - **The answer, spoken**: Morgan's sentences (`sentence` events) for the turn asked here, each made sound by the web
 *   side (`/api/morgan/speak`, WAV) as it comes, and played one after another. Turns asked elsewhere, typed ones, and
 *   reminders are not spoken here.
 * - iOS plays sound only once a press has let it: the press on the microphone unlocks the page's audio, and it stays
 *   unlocked for the answer.
 * - The page shows all of it as it shows Morgan's states (listening, transcribing, speaking, the level meter), through
 *   the bridge (bridge.js, `WEB.morgan`).
 */
(() => {
  const WEB = window.TALARIS_WEB || { prefix: "/talaris" };
  const M = window.talarisWeb?.morgan;
  const mic = document.getElementById("mic");
  if (!M || !mic) return;
  const Ctx = window.AudioContext || window.webkitAudioContext;
  if (!navigator.mediaDevices?.getUserMedia || !window.MediaRecorder || !Ctx) {
    // A browser that cannot record (or a page not over HTTPS): typed only, as before.
    document.documentElement.classList.add("no-voice");
    return;
  }

  // ------------------------------------------------------------ sound out

  let ctx = null;
  /** The page's audio, made and let play within a press (iOS's rule), and kept. */
  function unlock() {
    if (!ctx) ctx = new Ctx();
    if (ctx.state !== "running") ctx.resume().catch(() => {});
    // A moment of silence, played within the press: what an older iOS needs before it plays anything later.
    try { const b = ctx.createBufferSource(); b.buffer = ctx.createBuffer(1, 1, 22050); b.connect(ctx.destination); b.start(0); } catch { /* fine */ }
  }

  let turn = 0;          // the turn asked here, counted; bumped to give up on one
  let ours = false;      // Morgan's events now are the answer to the turn asked here
  let waiting = false;   // asked; its `user` event not yet come
  let queue = Promise.resolve();
  let playing = null;    // the sentence sounding now
  let pending = 0;       // sentences made or being made, not yet played out
  let levelTimer = null;

  const post = (path, body, type) => fetch(`${WEB.prefix}${path}`, {
    method: "POST", credentials: "same-origin", body,
    headers: { "content-type": type, "x-talaris": "1" },
  }).then((r) => {
    // Signed out meanwhile: to the sign-in page, as the bridge goes.
    if (r.status === 401) { location.href = `${WEB.prefix}/login?then=${encodeURIComponent(location.pathname)}`; throw new Error("signed out"); }
    return r;
  });

  /** One of Morgan's sentences, made sound now and played after those before it. */
  function say(text) {
    const mine = turn;
    pending++;
    const sound = post("/api/morgan/speak", JSON.stringify({ text }), "application/json")
      .then((r) => (r.ok && r.status !== 204 ? r.arrayBuffer() : null))
      .then((data) => (data && mine === turn ? new Promise((ok, no) => ctx.decodeAudioData(data, ok, no)) : null))
      .catch(() => null);
    queue = queue.then(() => sound).then((buffer) => (buffer && mine === turn ? play(buffer) : null)).finally(() => {
      pending--;
      settle();
    });
  }

  function play(buffer) {
    return new Promise((done) => {
      const source = ctx.createBufferSource();
      const meter = ctx.createAnalyser();
      meter.fftSize = 512;
      source.buffer = buffer;
      source.connect(meter);
      meter.connect(ctx.destination);
      playing = source;
      M.doing("speaking");
      levels(meter, "morgan");
      source.onended = () => { if (playing === source) playing = null; done(); };
      source.start();
    });
  }

  /** Nothing left to play: Morgan's own state shown again (thinking, if more of the answer is coming). */
  function settle() {
    if (pending || playing || recorder || starting || sending) return;
    quietLevels();
    M.doing("");
  }

  function hush() {
    turn++;
    ours = false;
    waiting = false;
    try { playing?.stop(); } catch { /* ended */ }
    playing = null;
    quietLevels();
    M.doing("");
  }

  // ------------------------------------------------------------ the level meter (the page's `level` events)

  function levels(analyser, who) {
    clearInterval(levelTimer);
    const data = new Uint8Array(analyser.fftSize);
    levelTimer = setInterval(() => {
      analyser.getByteTimeDomainData(data);
      let sum = 0;
      for (const v of data) sum += ((v - 128) / 128) ** 2;
      M.event({ type: "level", who, value: Math.min(1, Math.sqrt(sum / data.length) * 4) });
    }, 60);
  }
  function quietLevels() { clearInterval(levelTimer); levelTimer = null; }

  // ------------------------------------------------------------ Morgan's events

  M.hear((ev) => {
    if (ev.type === "user" && waiting) { waiting = false; ours = true; return; }
    if (!ours) return;
    if (ev.type === "sentence" && ev.text) say(ev.text);
    // The turn is over: filed, given up, or the brain gone back to idle with nothing more to come.
    if (ev.type === "filed" || ev.type === "dismiss" || ev.type === "new" || (ev.type === "state" && (ev.state === "idle" || ev.state === "absent"))) {
      ours = false;
      settle();
    }
    if (ev.type === "dismiss" || ev.type === "new") hush();
  });

  // ------------------------------------------------------------ sound in

  let recorder = null;
  let starting = false;  // the microphone asked for, not yet given
  let sending = null;    // the recording on its way to be made words
  let pressedAt = 0;
  let cancelNext = false;

  const TYPES = ["audio/mp4", "audio/webm;codecs=opus", "audio/webm", "audio/ogg;codecs=opus", "audio/ogg"];

  async function listen() {
    let stream;
    M.doing("listening");
    starting = true;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
    } catch (e) {
      starting = false;
      M.doing("");
      M.event({ type: "error", message: e?.name === "NotAllowedError" ? "This browser was not allowed the microphone." : `No microphone (${e?.message || e})` });
      return;
    }
    starting = false;
    // Pressed again while the microphone was being given: nothing was meant to be heard.
    if (cancelNext) { cancelNext = false; for (const t of stream.getTracks()) t.stop(); M.doing(""); return; }
    const type = TYPES.find((t) => MediaRecorder.isTypeSupported?.(t));
    const r = new MediaRecorder(stream, type ? { mimeType: type } : undefined);
    const chunks = [];
    r.ondataavailable = (e) => { if (e.data?.size) chunks.push(e.data); };
    r.onstop = () => {
      // The microphone given back at once: a phone stops showing it in use, and plays sound through its speaker again.
      for (const t of stream.getTracks()) t.stop();
      quietLevels();
      if (r.cancelled) return M.doing("");
      send(new Blob(chunks, { type: r.mimeType || type || "audio/mp4" }));
    };
    recorder = r;
    try {
      const source = ctx.createMediaStreamSource(stream);
      const meter = ctx.createAnalyser();
      meter.fftSize = 512;
      source.connect(meter);
      levels(meter, "user");
    } catch { /* no meter; still heard */ }
    // In pieces, so that something is had even if the recording is cut short.
    r.start(1000);
  }

  function finish(cancel = false) {
    const r = recorder;
    recorder = null;
    if (!r) return;
    r.cancelled = cancel;
    if (r.state !== "inactive") r.stop();
  }

  async function send(blob) {
    M.doing("transcribing");
    const mine = turn;
    const going = sending = post("/api/morgan/hear", blob, blob.type || "application/octet-stream").then((r) => r.json()).catch((e) => ({ ok: false, error: e.message }));
    const heard = await going;
    if (sending === going) sending = null;
    if (mine !== turn) return;
    if (!heard.ok) { M.doing(""); M.event({ type: "error", message: heard.error || "That could not be heard" }); return; }
    if (!heard.text) { M.doing(""); M.event({ type: "error", message: "Nothing was heard." }); return; }
    waiting = true;
    M.doing("");
    line(`say ${heard.text.replace(/\s+/g, " ")}`, (a) => {
      try { const r = JSON.parse(a); if (!r.ok) { waiting = false; M.event({ type: "error", message: r.error || "Morgan didn't take that" }); } } catch { /* answered on watch */ }
    });
  }

  // ------------------------------------------------------------ the button

  /** A line to Morgan, as the page sends its own (its `bridge.call`; the page's `bridge` is its script's). */
  // eslint-disable-next-line no-undef
  const line = (text, then) => { const b = typeof bridge !== "undefined" ? bridge : null; if (b?.call) b.call(text, then); };
  /** Stopped: and then asked how Morgan stands, since a turn stopped while thinking may say no state of its own after. */
  function stop() {
    line("stop", () => setTimeout(() => line("status", (a) => { try { M.known(JSON.parse(a).state); } catch { /* not up */ } }), 500));
  }

  // The page's own handler (bridge.call("toggle"), which only a desktop's daemon can do) is never reached: presses on
  // the microphone are taken here, before it.
  const busy = () => ["thinking", "consulting", "speaking", "transcribing"].includes(M.state);
  window.addEventListener("pointerdown", (e) => {
    if (!mic.contains(e.target)) return;
    e.preventDefault();
    e.stopPropagation();
    unlock();
    if (recorder) { finish(); return; }
    if (starting) { cancelNext = true; return; }
    // Morgan working or speaking, or a recording being made words: stopped, as the desktop's button does.
    if (sending || playing || pending || ours || waiting || busy()) {
      sending = null;
      hush();
      stop();
      return;
    }
    pressedAt = Date.now();
    hush();
    listen();
  }, true);
  window.addEventListener("pointerup", (e) => {
    if (!mic.contains(e.target) && !recorder) return;
    unlock();
    // Held down and let go: sent. A tap leaves it listening for the next.
    if (recorder && pressedAt && Date.now() - pressedAt > 600) finish();
    pressedAt = 0;
  }, true);
  window.addEventListener("pointercancel", () => { pressedAt = 0; }, true);
  window.addEventListener("click", (e) => {
    if (!mic.contains(e.target)) return;
    e.preventDefault();
    e.stopPropagation();
    unlock();
  }, true);
  // How Morgan stands, from `status`, once the page is connected: what decides whether a press listens or stops, and a
  // device's `watch` has been seen to open on a state it had left (a laptop's, "thinking" while idle).
  const settled = setInterval(() => {
    if (typeof bridge === "undefined" || !bridge?.call) return;
    clearInterval(settled);
    line("status", (a) => { try { M.known(JSON.parse(a).state); } catch { /* not up */ } });
  }, 200);
  // Escape, or leaving the page: what is being recorded is dropped, not sent.
  document.addEventListener("keydown", (e) => { if (e.key === "Escape" && recorder) finish(true); });
  document.addEventListener("visibilitychange", () => { if (document.hidden && recorder) finish(true); });
})();
