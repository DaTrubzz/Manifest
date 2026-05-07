/* ============================================================
   Manifest — Fitness habits PWA
   - LocalStorage-first, Supabase sync with email/password auth.
   - Exposes window.manifest command bus for agents.
   - Handles ?action=... URL deep links.
============================================================ */

// ── Push notification VAPID public key ────────────────────────────────────
const VAPID_PUBLIC_KEY = "BFz5YIx2FDGu_uIo1lx-jrVu6I7uWjLoSa8fPMW2l_JjCh08qu87rCNtxzYlTYpj3rqB9fsxohz1DqTSz5OT2JU";

function urlBase64ToUint8Array(b64) {
  const pad = "=".repeat((4 - b64.length % 4) % 4);
  const raw = atob((b64 + pad).replace(/-/g, "+").replace(/_/g, "/"));
  return Uint8Array.from([...raw].map(c => c.charCodeAt(0)));
}

// ── Supabase config ────────────────────────────────────────────────────────
const SUPABASE_URL = "https://ablwnzpllekdtxnmurax.supabase.co";
const SUPABASE_KEY = "sb_publishable_4BWYlRVGmdlm_B3e2iEg0g_704GJL1T";
// ──────────────────────────────────────────────────────────────────────────

const KEY = "manifest.v1";
const DEFAULTS = {
  settings: {
    name: "", waterGoal: 8, sleepGoal: 8, installDismissed: false,
    sync: { url: "", key: "" }
  },
  days: {}
};

function load() {
  try {
    const raw = localStorage.getItem(KEY);
    const fallbackRaw = !raw ? localStorage.getItem("daily.v1") : null;
    const source = raw || fallbackRaw;
    if (!source) return structuredClone(DEFAULTS);
    const parsed = JSON.parse(source);
    return {
      ...structuredClone(DEFAULTS), ...parsed,
      settings: {
        ...DEFAULTS.settings, ...(parsed.settings || {}),
        sync: { ...DEFAULTS.settings.sync, ...((parsed.settings || {}).sync || {}) }
      }
    };
  } catch (e) { return structuredClone(DEFAULTS); }
}
function save() {
  state.lastLocalUpdate = Date.now();
  localStorage.setItem(KEY, JSON.stringify(state));
  schedulePush();
}
let state = load();

/* ---------- date helpers ---------- */
function todayKey(d = new Date()) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}
function addDays(date, n) { const d = new Date(date); d.setDate(d.getDate() + n); return d; }
function fmtLong(d) { return d.toLocaleDateString(undefined, { weekday: "long", month: "long", day: "numeric" }); }

function getDay(key) { return state.days[key] || {}; }
function setDay(key, patch) {
  const merged = { ...getDay(key), ...patch };
  Object.keys(merged).forEach(k => merged[k] === undefined && delete merged[k]);
  state.days[key] = merged;
  save();
}

function isWorkoutDone(d)  { return !!(d.workout && d.workout.type); }
function isWaterDone(d)    { return !!(d.water && d.water.glasses >= state.settings.waterGoal); }
function isSleepDone(d)    { return !!(d.sleep && d.sleep.hours > 0); }
function isFoodDone(d)     { return !!(d.nutrition && d.nutrition.rating); }

function dayCompletion(d) {
  let n = 0;
  if (isWorkoutDone(d)) n++;
  if (isWaterDone(d))   n++;
  if (isSleepDone(d))   n++;
  if (isFoodDone(d))    n++;
  return n;
}
function streakFor(predicate, fromDate = new Date()) {
  let n = 0; let cursor = new Date(fromDate);
  const todayDone = predicate(getDay(todayKey(cursor)));
  if (!todayDone) cursor = addDays(cursor, -1);
  while (true) {
    const k = todayKey(cursor);
    if (predicate(getDay(k))) { n++; cursor = addDays(cursor, -1); }
    else break;
  }
  return n;
}
function bestStreakOverall() {
  const keys = Object.keys(state.days).sort();
  if (keys.length === 0) return 0;
  let best = 0, cur = 0, prev = null;
  for (const k of keys) {
    const d = state.days[k];
    if (dayCompletion(d) === 4) {
      if (prev) {
        const expected = todayKey(addDays(new Date(prev), 1));
        cur = (k === expected) ? cur + 1 : 1;
      } else cur = 1;
      best = Math.max(best, cur); prev = k;
    } else { cur = 0; prev = null; }
  }
  return best;
}

/* ===========================================================
   SUPABASE SYNC — email/password auth, one row per user.
=========================================================== */
let _sb = null;
let _pushTimer = null;
let _pullTimer = null;
let _session = null;

function resolvedConfig() {
  return {
    url: SUPABASE_URL || state.settings.sync.url,
    key: SUPABASE_KEY || state.settings.sync.key,
  };
}

async function getSupabase() {
  const { url, key } = resolvedConfig();
  if (!url || !key) return null;
  if (_sb) return _sb;
  try {
    const mod = await import("https://esm.sh/@supabase/supabase-js@2");
    _sb = mod.createClient(url, key, {
      auth: { persistSession: true, autoRefreshToken: true }
    });
    return _sb;
  } catch (e) {
    console.warn("Failed to load Supabase:", e);
    setSyncStatus("err", "Sync library failed");
    return null;
  }
}

/* ── Auth ── */

async function initAuth() {
  const sb = await getSupabase();
  if (!sb) { renderAuthState(); return; }

  const { data: { session } } = await sb.auth.getSession();
  _session = session;
  if (session) {
    startSyncLoop();
    renderNotifUI();
  } else {
    const { url } = resolvedConfig();
    if (url) document.getElementById("authOverlay").style.display = "flex";
  }
  renderAuthState();

  sb.auth.onAuthStateChange((event, session) => {
    _session = session;
    if (event === "SIGNED_IN") {
      document.getElementById("authOverlay").style.display = "none";
      startSyncLoop();
      render();
      renderNotifUI();
    } else if (event === "SIGNED_OUT") {
      clearInterval(_pullTimer);
      setSyncStatus("", "");
    }
    renderAuthState();
  });
}

function renderAuthState() {
  const { url, key } = resolvedConfig();
  const configured = !!(url && key);
  document.getElementById("syncConfigCard").style.display = configured ? "none" : "";
  document.getElementById("syncAccountCard").style.display = configured ? "" : "none";

  if (!configured) {
    document.getElementById("setSupabaseUrl").value = state.settings.sync.url || "";
    document.getElementById("setSupabaseKey").value = state.settings.sync.key || "";
    return;
  }

  const signedIn = !!_session;
  document.getElementById("authFormSection").style.display = signedIn ? "none" : "";
  document.getElementById("signedInSection").style.display = signedIn ? "" : "none";
  document.getElementById("accountStatus").textContent = signedIn
    ? `Signed in as ${_session.user.email}`
    : "Sign in to sync across devices";

  // Show disconnect only when config is from settings (not hardcoded constants)
  document.getElementById("disconnectBtn").style.display =
    (!SUPABASE_URL && state.settings.sync.url) ? "" : "none";
}

function showMsg(elId, text, type = "error") {
  const el = document.getElementById(elId);
  el.textContent = text;
  el.className = `auth-msg ${type}`;
  el.style.display = "";
}
function clearMsg(elId) {
  const el = document.getElementById(elId);
  el.style.display = "none";
  el.textContent = "";
}

/* ── Sync ── */

function schedulePush() {
  if (!_session) return;
  clearTimeout(_pushTimer);
  setSyncStatus("busy", "Saving…");
  _pushTimer = setTimeout(pushNow, 1500);
}

async function pushNow() {
  _pushTimer = null; // mark debounce as complete so pulls can resume
  const sb = await getSupabase();
  if (!sb || !_session) return;
  try {
    const payload = {
      user_id: _session.user.id,
      data: {
        settings: {
          name: state.settings.name,
          waterGoal: state.settings.waterGoal,
          sleepGoal: state.settings.sleepGoal,
          installDismissed: state.settings.installDismissed,
        },
        days: state.days
      },
      updated_at: new Date().toISOString()
    };
    const { error } = await sb.from("manifest_data").upsert(payload, { onConflict: "user_id" });
    if (error) throw error;
    setSyncStatus("ok", "Synced");
  } catch (e) {
    console.warn("push failed:", e);
    setSyncStatus("err", "Sync error — see console");
  }
}

async function pullNow() {
  const sb = await getSupabase();
  if (!sb || !_session) return;
  if (_pushTimer) return; // don't overwrite local changes mid-debounce
  try {
    setSyncStatus("busy", "Syncing…");
    const { data, error } = await sb.from("manifest_data")
      .select("data, updated_at").eq("user_id", _session.user.id).maybeSingle();
    if (error) throw error;
    if (!data) {
      // No remote data yet — push local data up on first sync
      await pushNow();
      return;
    }
    const remote = data.data || {};
    state.days = remote.days || {};
    state.settings = {
      ...state.settings,
      ...(remote.settings || {}),
      sync: state.settings.sync // keep local sync config
    };
    state.lastLocalUpdate = new Date(data.updated_at).getTime();
    localStorage.setItem(KEY, JSON.stringify(state));
    render();
    setSyncStatus("ok", "Synced");
  } catch (e) {
    console.warn("pull failed:", e);
    setSyncStatus("err", "Sync error — see console");
  }
}

function startSyncLoop() {
  clearInterval(_pullTimer);
  if (!_session) return;
  setSyncStatus("busy", "Connecting…");
  pullNow();
  _pullTimer = setInterval(pullNow, 5_000);
}

function setSyncStatus(cls, text) {
  const pill = document.getElementById("syncPill");
  const status = document.getElementById("syncStatus");
  if (!_session) { pill.style.display = "none"; return; }
  pill.style.display = "inline-flex";
  pill.classList.remove("ok", "err", "busy");
  if (cls) pill.classList.add(cls);
  status.textContent = text;
}

/* ===========================================================
   COMMAND BUS — window.manifest
=========================================================== */
window.manifest = {
  getState() { return JSON.parse(JSON.stringify(state)); },
  getToday() {
    const tk = todayKey();
    const d = getDay(tk);
    return {
      date: tk,
      workout: d.workout || null,
      water: { glasses: (d.water && d.water.glasses) || 0, goal: state.settings.waterGoal },
      sleep: d.sleep || null,
      nutrition: d.nutrition || null,
      completion: dayCompletion(d),
    };
  },
  getDay(dateKey) { return getDay(dateKey); },
  getStreak(habit) {
    const fns = { workout: isWorkoutDone, water: isWaterDone, sleep: isSleepDone, nutrition: isFoodDone,
                  all: d => dayCompletion(d) === 4 };
    if (!fns[habit]) throw new Error(`Unknown habit: ${habit}. Try workout|water|sleep|nutrition|all`);
    return streakFor(fns[habit]);
  },
  getHistory(days = 30) {
    const today = new Date(); const out = [];
    for (let i = days - 1; i >= 0; i--) {
      const d = addDays(today, -i); const k = todayKey(d);
      out.push({ date: k, ...getDay(k), completion: dayCompletion(getDay(k)) });
    }
    return out;
  },
  logWorkout(type, note) {
    const valid = ["Strength","Cardio","Mobility","Other"];
    if (!valid.includes(type)) throw new Error(`Invalid workout type. Try: ${valid.join(", ")}`);
    setDay(todayKey(), { workout: { type, note: note || "", at: Date.now() } });
    render(); return this.getToday();
  },
  clearWorkout() { setDay(todayKey(), { workout: undefined }); render(); return this.getToday(); },
  logWater(glasses) {
    const tk = todayKey();
    const cur = (getDay(tk).water && getDay(tk).water.glasses) || 0;
    const next = Math.max(0, cur + (glasses ?? 1));
    setDay(tk, { water: { glasses: next } });
    render(); return this.getToday();
  },
  setWater(glasses) {
    setDay(todayKey(), { water: { glasses: Math.max(0, glasses|0) } });
    render(); return this.getToday();
  },
  logSleep(hours, quality = 0) {
    const h = parseFloat(hours);
    if (!(h >= 0 && h <= 24)) throw new Error("hours must be 0–24");
    const q = Math.max(0, Math.min(5, parseInt(quality) || 0));
    setDay(todayKey(), { sleep: { hours: h, quality: q } });
    render(); return this.getToday();
  },
  logNutrition(rating) {
    const valid = ["good","ok","off"];
    if (!valid.includes(rating)) throw new Error(`rating must be one of ${valid.join("|")}`);
    setDay(todayKey(), { nutrition: { rating } });
    render(); return this.getToday();
  },
  setGoal(which, value) {
    if (which === "water") state.settings.waterGoal = Math.max(1, value|0);
    else if (which === "sleep") state.settings.sleepGoal = Math.max(3, parseFloat(value));
    else throw new Error("which must be 'water' or 'sleep'");
    save(); render(); return { settings: state.settings };
  },
  syncNow() { return pushNow().then(() => pullNow()); }
};

/* ===========================================================
   URL DEEP LINKS
=========================================================== */
function handleDeepLink() {
  const p = new URLSearchParams(location.search);
  const action = p.get("action");
  if (!action) return;
  try {
    switch (action) {
      case "water":
        window.manifest.logWater(parseInt(p.get("n")) || 1); break;
      case "workout":
        window.manifest.logWorkout(p.get("type") || "Other", p.get("note") || ""); break;
      case "sleep":
        window.manifest.logSleep(parseFloat(p.get("hours")), parseInt(p.get("quality")) || 0); break;
      case "nutrition":
        window.manifest.logNutrition(p.get("rating") || "good"); break;
    }
    flash(`Action: ${action}`);
    history.replaceState({}, "", location.pathname);
  } catch (e) { console.warn("Deep-link error:", e); }
}

/* ---------- rendering ---------- */
function render() {
  const today = new Date();
  const tk = todayKey(today);
  const td = getDay(tk);

  const hour = today.getHours();
  const greet = hour < 5 ? "Up late" : hour < 12 ? "Good morning" : hour < 18 ? "Good afternoon" : "Good evening";
  const name = state.settings.name ? `, ${state.settings.name}` : "";
  document.getElementById("greeting").textContent = `${greet}${name}`;
  document.getElementById("todayDate").textContent = fmtLong(today);

  const strip = document.getElementById("weekStrip");
  strip.innerHTML = "";
  for (let i = 6; i >= 0; i--) {
    const d = addDays(today, -i);
    const key = todayKey(d);
    const day = getDay(key);
    const c = dayCompletion(day);
    const cls = c === 4 ? "complete" : c > 0 ? "partial" : "";
    const isToday = i === 0 ? "today" : "";
    const dow = d.toLocaleDateString(undefined, { weekday: "short" }).slice(0, 3);
    strip.insertAdjacentHTML("beforeend",
      `<div class="day-pill ${cls} ${isToday}"><div class="dow">${dow}</div><div class="num">${d.getDate()}</div><div class="ring"></div></div>`);
  }

  const wType = td.workout && td.workout.type;
  document.getElementById("workoutSub").textContent = wType ? `Done — ${wType}` : "Not logged yet";
  document.querySelectorAll("#workoutTypes button[data-type]").forEach(b => {
    b.classList.toggle("btn-primary", b.dataset.type === wType);
  });
  document.getElementById("clearWorkout").style.display = wType ? "" : "none";
  const ws = streakFor(isWorkoutDone);
  const wsEl = document.getElementById("workoutStreak");
  wsEl.textContent = ws + "d"; wsEl.classList.toggle("hot", ws >= 3);

  const water = (td.water && td.water.glasses) || 0;
  const goal = state.settings.waterGoal;
  document.getElementById("waterNow").textContent = water;
  document.getElementById("waterGoal").textContent = goal;
  document.getElementById("waterSub").textContent = `Goal: ${goal} glasses`;
  document.getElementById("waterFill").style.width = Math.min(100, (water / goal) * 100) + "%";
  const wts = streakFor(isWaterDone);
  const wtsEl = document.getElementById("waterStreak");
  wtsEl.textContent = wts + "d"; wtsEl.classList.toggle("hot", wts >= 3);

  if (td.sleep && td.sleep.hours) {
    document.getElementById("sleepSub").textContent =
      `${td.sleep.hours}h · ${"★".repeat(td.sleep.quality || 0)}${"☆".repeat(5 - (td.sleep.quality || 0))}`;
    document.getElementById("logSleepBtn").textContent = "Edit sleep";
  } else {
    document.getElementById("sleepSub").textContent = "Tap to log last night";
    document.getElementById("logSleepBtn").textContent = "Log sleep";
  }
  const ss = streakFor(isSleepDone);
  const ssEl = document.getElementById("sleepStreak");
  ssEl.textContent = ss + "d"; ssEl.classList.toggle("hot", ss >= 3);

  const rating = td.nutrition && td.nutrition.rating;
  document.querySelectorAll("#foodSeg button").forEach(b => {
    b.classList.toggle("active", b.dataset.rating === rating);
  });
  document.getElementById("foodSub").textContent =
    rating === "good" ? "Eating on plan today" :
    rating === "ok"   ? "So-so eating today" :
    rating === "off"  ? "Off plan today" : "How did you eat today?";
  const fs = streakFor(isFoodDone);
  const fsEl = document.getElementById("foodStreak");
  fsEl.textContent = fs + "d"; fsEl.classList.toggle("hot", fs >= 3);

  renderHistory();

  document.getElementById("setName").value = state.settings.name || "";
  document.getElementById("setWaterGoal").value = state.settings.waterGoal;
  document.getElementById("setSleepGoal").value = state.settings.sleepGoal;
}
function renderHistory() {
  const today = new Date();
  document.getElementById("historyMonth").textContent =
    today.toLocaleDateString(undefined, { month: "long", year: "numeric" });
  document.getElementById("bestStreak").textContent = bestStreakOverall();
  const grid = document.getElementById("historyGrid");
  grid.innerHTML = "";
  let logged = 0;
  for (let i = 29; i >= 0; i--) {
    const d = addDays(today, -i); const key = todayKey(d);
    const day = getDay(key); const c = dayCompletion(day);
    if (c > 0) logged++;
    const cls = c === 4 ? "full" : c > 0 ? "partial" : "";
    const todayCls = i === 0 ? "today" : "";
    grid.insertAdjacentHTML("beforeend",
      `<div class="h-cell ${cls} ${todayCls}"><div class="h-num">${d.getDate()}</div><div class="h-dot"></div></div>`);
  }
  document.getElementById("daysLogged").textContent = logged;
}

/* ---------- interactions ---------- */
function bind() {
  document.querySelectorAll("#workoutTypes button[data-type]").forEach(btn => {
    btn.addEventListener("click", () => {
      const cur = (getDay(todayKey()).workout || {}).type;
      if (cur === btn.dataset.type) window.manifest.clearWorkout();
      else window.manifest.logWorkout(btn.dataset.type);
    });
  });
  document.getElementById("clearWorkout").addEventListener("click", () => window.manifest.clearWorkout());

  document.getElementById("waterPlus").addEventListener("click", () => window.manifest.logWater(1));
  document.getElementById("waterMinus").addEventListener("click", () => window.manifest.logWater(-1));

  document.querySelectorAll("#foodSeg button").forEach(btn => {
    btn.addEventListener("click", () => {
      const cur = (getDay(todayKey()).nutrition || {}).rating;
      if (cur === btn.dataset.rating) { setDay(todayKey(), { nutrition: undefined }); render(); }
      else window.manifest.logNutrition(btn.dataset.rating);
    });
  });

  // sleep sheet
  const sheet = document.getElementById("sleepSheet");
  document.getElementById("logSleepBtn").addEventListener("click", () => {
    const cur = getDay(todayKey()).sleep || {};
    document.getElementById("sleepHours").value = cur.hours || state.settings.sleepGoal;
    setStars(cur.quality || 0);
    sheet.classList.add("open");
  });
  document.getElementById("closeSleepSheet").addEventListener("click", () => sheet.classList.remove("open"));
  sheet.addEventListener("click", (e) => { if (e.target === sheet) sheet.classList.remove("open"); });
  let chosenQuality = 0;
  function setStars(q) {
    chosenQuality = q;
    document.querySelectorAll("#sleepStars .star").forEach(s => {
      s.classList.toggle("active", parseInt(s.dataset.q) <= q);
    });
  }
  document.querySelectorAll("#sleepStars .star").forEach(s => {
    s.addEventListener("click", () => setStars(parseInt(s.dataset.q)));
  });
  document.getElementById("saveSleep").addEventListener("click", () => {
    const hours = parseFloat(document.getElementById("sleepHours").value) || 0;
    window.manifest.logSleep(hours, chosenQuality);
    sheet.classList.remove("open");
  });

  // nav
  document.querySelectorAll(".nav-btn").forEach(b => {
    b.addEventListener("click", () => {
      document.querySelectorAll(".nav-btn").forEach(x => x.classList.remove("active"));
      b.classList.add("active");
      document.querySelectorAll(".screen").forEach(s => s.classList.remove("active"));
      document.getElementById("screen-" + b.dataset.screen).classList.add("active");
      window.scrollTo(0, 0);
    });
  });

  // goals
  document.getElementById("saveSettings").addEventListener("click", () => {
    state.settings.name = document.getElementById("setName").value.trim();
    state.settings.waterGoal = Math.max(1, parseInt(document.getElementById("setWaterGoal").value) || 8);
    state.settings.sleepGoal = Math.max(3, parseFloat(document.getElementById("setSleepGoal").value) || 8);
    save(); render(); flash("Saved");
  });

  document.getElementById("exportData").addEventListener("click", () => {
    const blob = new Blob([JSON.stringify(state, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url; a.download = "manifest-export.json";
    document.body.appendChild(a); a.click(); a.remove();
    URL.revokeObjectURL(url);
  });
  document.getElementById("resetData").addEventListener("click", () => {
    if (confirm("Erase ALL of your tracked days and settings? This can't be undone.")) {
      localStorage.removeItem(KEY);
      state = load(); render(); flash("Data cleared");
    }
  });

  // ── Supabase connect ──
  document.getElementById("connectBtn").addEventListener("click", async () => {
    const url = document.getElementById("setSupabaseUrl").value.trim();
    const key = document.getElementById("setSupabaseKey").value.trim();
    if (!url || !key) { alert("Please enter your Supabase URL and anon key."); return; }
    state.settings.sync = { url, key };
    save();
    _sb = null; // force re-init
    renderAuthState();
    await initAuth();
  });

  // ── Auth overlay ──
  document.getElementById("authShowSignUp").addEventListener("click", () => {
    document.getElementById("authSignInForm").style.display = "none";
    document.getElementById("authSignUpForm").style.display = "";
    clearMsg("authMsg");
  });
  document.getElementById("authShowSignIn").addEventListener("click", () => {
    document.getElementById("authSignUpForm").style.display = "none";
    document.getElementById("authSignInForm").style.display = "";
    clearMsg("authMsg");
  });

  document.getElementById("authSignInBtn").addEventListener("click", async () => {
    const sb = await getSupabase();
    if (!sb) return;
    const email = document.getElementById("authEmail").value.trim();
    const password = document.getElementById("authPassword").value;
    if (!email || !password) { showMsg("authMsg", "Please enter your email and password."); return; }
    document.getElementById("authSignInBtn").disabled = true;
    const { error } = await sb.auth.signInWithPassword({ email, password });
    document.getElementById("authSignInBtn").disabled = false;
    if (error) { showMsg("authMsg", error.message); return; }
    clearMsg("authMsg");
  });

  document.getElementById("authSignUpBtn").addEventListener("click", async () => {
    const sb = await getSupabase();
    if (!sb) return;
    const email = document.getElementById("signUpEmail").value.trim();
    const password = document.getElementById("signUpPassword").value;
    if (!email || !password) { showMsg("authMsg", "Please enter your email and password."); return; }
    if (password.length < 6) { showMsg("authMsg", "Password must be at least 6 characters."); return; }
    document.getElementById("authSignUpBtn").disabled = true;
    const { data, error } = await sb.auth.signUp({ email, password });
    document.getElementById("authSignUpBtn").disabled = false;
    if (error) { showMsg("authMsg", error.message); return; }
    if (data.session) {
      clearMsg("authMsg"); // signed in immediately (email confirm disabled)
    } else {
      showMsg("authMsg", "Check your email and click the confirmation link, then sign in.", "info");
      document.getElementById("authSignUpForm").style.display = "none";
      document.getElementById("authSignInForm").style.display = "";
    }
  });

  // ── Settings auth forms ──
  document.getElementById("settingsShowSignUp").addEventListener("click", () => {
    document.getElementById("settingsSignInSection").style.display = "none";
    document.getElementById("settingsSignUpSection").style.display = "";
  });
  document.getElementById("settingsShowSignIn").addEventListener("click", () => {
    document.getElementById("settingsSignUpSection").style.display = "none";
    document.getElementById("settingsSignInSection").style.display = "";
  });

  document.getElementById("settingsSignInBtn").addEventListener("click", async () => {
    const sb = await getSupabase();
    if (!sb) return;
    const email = document.getElementById("settingsEmail").value.trim();
    const password = document.getElementById("settingsPassword").value;
    if (!email || !password) { showMsg("settingsSignInMsg", "Please enter your email and password."); return; }
    document.getElementById("settingsSignInBtn").disabled = true;
    const { error } = await sb.auth.signInWithPassword({ email, password });
    document.getElementById("settingsSignInBtn").disabled = false;
    if (error) { showMsg("settingsSignInMsg", error.message); return; }
    clearMsg("settingsSignInMsg");
    flash("Signed in");
  });

  document.getElementById("settingsSignUpBtn").addEventListener("click", async () => {
    const sb = await getSupabase();
    if (!sb) return;
    const email = document.getElementById("settingsSignUpEmail").value.trim();
    const password = document.getElementById("settingsSignUpPwd").value;
    if (!email || !password) { showMsg("settingsSignUpMsg", "Please enter your email and password."); return; }
    if (password.length < 6) { showMsg("settingsSignUpMsg", "Password must be at least 6 characters."); return; }
    document.getElementById("settingsSignUpBtn").disabled = true;
    const { data, error } = await sb.auth.signUp({ email, password });
    document.getElementById("settingsSignUpBtn").disabled = false;
    if (error) { showMsg("settingsSignUpMsg", error.message); return; }
    if (data.session) {
      clearMsg("settingsSignUpMsg"); flash("Account created");
    } else {
      showMsg("settingsSignUpMsg", "Check your email for a confirmation link.", "info");
    }
  });

  document.getElementById("signOutBtn").addEventListener("click", async () => {
    const sb = await getSupabase();
    if (sb) await sb.auth.signOut();
    flash("Signed out");
  });

  // notifications
  document.getElementById("enableNotifBtn")?.addEventListener("click", async () => {
    const isiOS = /iPad|iPhone|iPod/.test(navigator.userAgent);
    const isStandalone = window.matchMedia("(display-mode: standalone)").matches || window.navigator.standalone === true;
    if (isiOS && !isStandalone) {
      flash("Open from your Home Screen first (Share → Add to Home Screen)");
      return;
    }
    if (!("Notification" in window)) {
      flash("Notifications not supported on this browser");
      return;
    }
    try {
      const permission = await Notification.requestPermission();
      renderNotifUI();
      if (permission === "denied") flash("Notifications blocked — check iPhone Settings");
    } catch (e) {
      flash("Could not enable notifications: " + e.message);
      console.warn("Notification error:", e);
    }
  });
  document.getElementById("saveNotifBtn")?.addEventListener("click", saveNotifPrefs);
  document.getElementById("disableNotifBtn")?.addEventListener("click", disableNotifs);

  document.getElementById("disconnectBtn").addEventListener("click", async () => {
    const sb = await getSupabase();
    if (sb) await sb.auth.signOut();
    state.settings.sync = { url: "", key: "" };
    save();
    _sb = null;
    renderAuthState();
    flash("Disconnected");
  });
}

/* ===========================================================
   PUSH NOTIFICATIONS
=========================================================== */
async function notifState() {
  if (!("Notification" in window) || !("PushManager" in window)) return "unsupported";
  return Notification.permission;
}

async function renderNotifUI() {
  if (!_session) return;
  const state = await notifState();
  const unsupported = document.getElementById("notifUnsupported");
  const supported = document.getElementById("notifSupported");
  if (!unsupported || !supported) return;
  unsupported.style.display = state === "unsupported" ? "" : "none";
  supported.style.display = state !== "unsupported" ? "" : "none";
  document.getElementById("notifDefault").style.display = state === "default" ? "" : "none";
  document.getElementById("notifGranted").style.display = state === "granted" ? "" : "none";
  document.getElementById("notifDenied").style.display = state === "denied" ? "" : "none";

  if (state === "granted") {
    const sb = await getSupabase();
    if (!sb) return;
    const { data } = await sb.from("push_subscriptions")
      .select("reminder_enabled, reminder_time, weekly_summary")
      .eq("user_id", _session.user.id).maybeSingle();
    if (data) {
      document.getElementById("reminderEnabled").checked = data.reminder_enabled;
      document.getElementById("reminderTime").value = data.reminder_time || "20:00";
      document.getElementById("weeklySummary").checked = data.weekly_summary;
    }
  }
}

async function saveNotifPrefs() {
  const sb = await getSupabase();
  if (!sb || !_session) return;
  const reg = await navigator.serviceWorker.ready;
  let sub = await reg.pushManager.getSubscription();
  if (!sub) {
    sub = await reg.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: urlBase64ToUint8Array(VAPID_PUBLIC_KEY)
    });
  }
  const { error } = await sb.from("push_subscriptions").upsert({
    user_id: _session.user.id,
    subscription: sub.toJSON(),
    reminder_enabled: document.getElementById("reminderEnabled").checked,
    reminder_time: document.getElementById("reminderTime").value || "20:00",
    weekly_summary: document.getElementById("weeklySummary").checked,
    tz_offset: new Date().getTimezoneOffset(),
    updated_at: new Date().toISOString()
  }, { onConflict: "user_id" });
  if (error) { flash("Failed to save"); return; }
  flash("Notification settings saved");
}

async function disableNotifs() {
  const sb = await getSupabase();
  if (!sb || !_session) return;
  const reg = await navigator.serviceWorker.ready;
  const sub = await reg.pushManager.getSubscription();
  if (sub) await sub.unsubscribe();
  await sb.from("push_subscriptions").delete().eq("user_id", _session.user.id);
  flash("Notifications disabled");
  renderNotifUI();
}

function flash(msg) {
  const t = document.createElement("div");
  t.textContent = msg;
  Object.assign(t.style, {
    position: "fixed", bottom: "100px", left: "50%", transform: "translateX(-50%)",
    background: "rgba(0,0,0,0.8)", color: "white", padding: "10px 16px",
    borderRadius: "999px", zIndex: 100, fontSize: "14px", fontWeight: "600",
    transition: "opacity .3s", opacity: "1"
  });
  document.body.appendChild(t);
  setTimeout(() => { t.style.opacity = "0"; }, 1200);
  setTimeout(() => t.remove(), 1600);
}

function maybeShowInstall() {
  const isStandalone = window.matchMedia("(display-mode: standalone)").matches
                       || window.navigator.standalone === true;
  const isiOS = /iPad|iPhone|iPod/.test(navigator.userAgent);
  if (isiOS && !isStandalone && !state.settings.installDismissed) {
    document.getElementById("installBanner").style.display = "block";
  }
}
function dismissInstall() {
  state.settings.installDismissed = true;
  save();
  document.getElementById("installBanner").style.display = "none";
}

if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("sw.js").catch(() => {});
  });
}

bind();
render();
maybeShowInstall();
handleDeepLink();
initAuth();
setInterval(() => render(), 60_000);
document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible") pullNow(); });
