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
    sync: { url: "", key: "" },
    sleepSchedule: { bedtime: "", lightsOut: "", wakeTime: "" }
  },
  days: {},
  tasks: [],
  habits: []
};

const CAT_COLORS = {
  // Health sub-categories
  health:      "#34c759",
  exercise:    "#34c759",
  sleep:       "#af52de",
  nutrition:   "#ff9500",
  // Lifestyle sub-categories
  lifestyle:   "#a855f7",
  hobbies:     "#a855f7",
  environment: "#30b86a",
  social:      "#ec4899",
  chores:      "#f59e0b",
  // Work sub-categories
  work:        "#3b82f6",
  occupation:  "#3b82f6",
  education:   "#6366f1",
  // Fallback
  other:       "#6b7280"
};

/* ── Habit helpers ────────────────────────────────────────────────────────── */
const SUB_TO_CAT = {
  exercise: "health",   sleep: "health",    nutrition: "health",
  hobbies:  "lifestyle",environment: "lifestyle", social: "lifestyle", chores: "lifestyle",
  occupation: "work",   education: "work",  other: "other"
};
function fmtT12(timeStr) {
  if (!timeStr) return "";
  const [h, m] = timeStr.split(":").map(Number);
  const dh = h === 0 ? 12 : h > 12 ? h - 12 : h;
  return `${dh}:${String(m).padStart(2, "0")}${h < 12 ? "am" : "pm"}`;
}
function formatWeekDays(days) {
  const names = ["Su","Mo","Tu","We","Th","Fr","Sa"];
  return (days||[]).slice().sort((a,b)=>a-b).map(d=>names[d]).join(", ") || "—";
}
function habitAppliesOnDate(habit, dateKey) {
  if (habit.repeat === "daily") return true;
  if (habit.repeat === "weekly") {
    const d = new Date(dateKey + "T12:00:00");
    return (habit.days || []).includes(d.getDay());
  }
  return false;
}

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
        sync: { ...DEFAULTS.settings.sync, ...((parsed.settings || {}).sync || {}) },
        sleepSchedule: { ...DEFAULTS.settings.sleepSchedule, ...((parsed.settings || {}).sleepSchedule || {}) }
      },
      tasks:  parsed.tasks  || [],
      habits: parsed.habits || []
    };
  } catch (e) { return structuredClone(DEFAULTS); }
}
function save() {
  state.lastLocalUpdate = Date.now();
  localStorage.setItem(KEY, JSON.stringify(state));
  schedulePush();
}
let state = load();

// Schedule tab state
let selectedDate = todayKey();
let _calYear  = new Date().getFullYear();
let _calMonth = new Date().getMonth();
let calView   = "week"; // "week" | "month"

// Add-item sheet state
let _sheetType   = "task";  // "task" | "habit"
let _habitRepeat = "daily"; // "daily" | "weekly"
let _habitDays   = [];      // selected weekdays for weekly habits [0-6]

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
let _pushing   = false;
let _pullTimer  = null;
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
  _pushTimer = null;
  _pushing   = true;
  const sb = await getSupabase();
  if (!sb || !_session) { _pushing = false; return; }
  try {
    const payload = {
      user_id: _session.user.id,
      data: {
        settings: {
          name: state.settings.name,
          waterGoal: state.settings.waterGoal,
          sleepGoal: state.settings.sleepGoal,
          installDismissed: state.settings.installDismissed,
          sleepSchedule: state.settings.sleepSchedule || {}
        },
        days:   state.days,
        tasks:  state.tasks  || [],
        habits: state.habits || []
      },
      updated_at: new Date().toISOString()
    };
    const { error } = await sb.from("manifest_data").upsert(payload, { onConflict: "user_id" });
    if (error) throw error;
    setSyncStatus("ok", "Synced");
  } catch (e) {
    console.warn("push failed:", e);
    setSyncStatus("err", "Sync error — see console");
  } finally {
    _pushing = false;
  }
}

async function pullNow() {
  const sb = await getSupabase();
  if (!sb || !_session) return;
  if (_pushTimer || _pushing) return; // don't overwrite local changes while saving
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
    state.days   = remote.days   || {};
    state.tasks  = remote.tasks  || [];
    state.habits = remote.habits || [];
    state.settings = {
      ...state.settings,
      ...(remote.settings || {}),
      sync: state.settings.sync, // keep local sync config
      sleepSchedule: remote.settings?.sleepSchedule || state.settings.sleepSchedule
    };
    state.lastLocalUpdate = new Date(data.updated_at).getTime();
    localStorage.setItem(KEY, JSON.stringify(state));
    render();
    // Refresh timeline if it's currently visible
    if (document.getElementById("cat-schedule")?.style.display !== "none") {
      renderMonthCalendar();
      renderTimeline(true);
    }
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
  renderSubSections();

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

/* ---------- calendar helpers ---------- */
function getWeekDates(dateStr) {
  const d = new Date(dateStr + "T12:00:00");
  const sunday = new Date(d);
  sunday.setDate(d.getDate() - d.getDay());
  return Array.from({ length: 7 }, (_, i) => {
    const day = new Date(sunday);
    day.setDate(sunday.getDate() + i);
    return day;
  });
}

const DOW_ROW = `<div class="cal-dow">Su</div><div class="cal-dow">Mo</div><div class="cal-dow">Tu</div><div class="cal-dow">We</div><div class="cal-dow">Th</div><div class="cal-dow">Fr</div><div class="cal-dow">Sa</div>`;

function calDayHTML(date, today) {
  const key      = todayKey(date);
  const comp     = dayCompletion(getDay(key));
  const hasTasks = (state.tasks || []).some(t => t.date === key);
  let cls = "cal-day";
  if (key === today)                         cls += " is-today";
  if (key === selectedDate && key !== today) cls += " is-selected";
  const habitDot = comp > 0 ? `<div class="cal-dot ${comp === 4 ? "dot-full" : "dot-partial"}"></div>` : "";
  const taskDot  = hasTasks ? `<div class="cal-dot dot-task"></div>` : "";
  const dots     = (habitDot || taskDot) ? `<div class="cal-day-dots">${habitDot}${taskDot}</div>` : "";
  return `<div class="${cls}" data-date="${key}"><span class="cal-day-num">${date.getDate()}</span>${dots}</div>`;
}

/* ---------- month calendar ---------- */
function renderMonthCalendar() {
  const cal = document.getElementById("monthCal");
  if (!cal) return;
  const today = todayKey();

  if (calView === "week") {
    // ── Weekly view ──────────────────────────────────────────
    const weekDates = getWeekDates(selectedDate);
    cal.innerHTML = `
      <div class="cal-grid">${DOW_ROW}${weekDates.map(d => calDayHTML(d, today)).join("")}</div>
      <div class="cal-toggle"><button class="cal-toggle-btn" id="calToggle" title="Expand to month view">↓</button></div>`;

  } else {
    // ── Monthly view ─────────────────────────────────────────
    const firstOfMonth = new Date(_calYear, _calMonth, 1);
    const daysInMonth  = new Date(_calYear, _calMonth + 1, 0).getDate();
    const startDow     = firstOfMonth.getDay();
    const monthLabel   = firstOfMonth.toLocaleDateString(undefined, { month: "long", year: "numeric" });
    const blanks       = Array.from({ length: startDow }, () => "<div></div>").join("");
    let dayCells       = blanks;
    for (let d = 1; d <= daysInMonth; d++) dayCells += calDayHTML(new Date(_calYear, _calMonth, d), today);

    cal.innerHTML = `
      <div class="month-nav">
        <button class="month-nav-btn" id="calPrev">‹</button>
        <span class="month-nav-title">${monthLabel}</span>
        <button class="month-nav-btn" id="calNext">›</button>
      </div>
      <div class="cal-grid">${DOW_ROW}${dayCells}</div>
      <div class="cal-toggle"><button class="cal-toggle-btn" id="calToggle" title="Collapse to week view">↑</button></div>`;

    cal.querySelector("#calPrev").addEventListener("click", () => {
      _calMonth--; if (_calMonth < 0)  { _calMonth = 11; _calYear--; }
      renderMonthCalendar();
    });
    cal.querySelector("#calNext").addEventListener("click", () => {
      _calMonth++; if (_calMonth > 11) { _calMonth = 0;  _calYear++; }
      renderMonthCalendar();
    });
  }

  // Toggle view
  cal.querySelector("#calToggle").addEventListener("click", () => {
    calView = calView === "week" ? "month" : "week";
    renderMonthCalendar();
  });

  // Day selection
  cal.querySelectorAll(".cal-day[data-date]").forEach(cell => {
    cell.addEventListener("click", () => {
      selectedDate = cell.dataset.date;
      const d = new Date(selectedDate + "T12:00:00");
      _calYear = d.getFullYear(); _calMonth = d.getMonth();
      renderMonthCalendar();
      renderTimeline();
    });
  });
}

/* ---------- timeline ---------- */
function renderTimeline(preserveScroll = false) {
  const tl = document.getElementById("timeline");
  if (!tl) return;

  const schedDateEl = document.getElementById("schedDate");
  if (schedDateEl) {
    const selD = new Date(selectedDate + "T12:00:00");
    schedDateEl.textContent = fmtLong(selD);
  }

  const tasks = (state.tasks || []).filter(t => t.date === selectedDate);

  const START_HOUR = 0;   // 12 am
  const END_HOUR   = 24;  // 12 am next day (closing marker)
  const HOUR_PX    = 60;  // px per hour (= 1 px per minute)

  tl.innerHTML = "";
  tl.style.height = ((END_HOUR - START_HOUR + 1) * HOUR_PX) + "px";

  // Hour rows
  for (let h = START_HOUR; h <= END_HOUR; h++) {
    const row = document.createElement("div");
    row.className = "tl-hour";
    const label = document.createElement("div");
    label.className = "tl-label";
    label.textContent = h === 0 || h === 24 ? "12am"
      : h === 12              ? "12pm"
      : h < 12                ? `${h}am`
      : `${h - 12}pm`;
    row.appendChild(label);
    tl.appendChild(row);
  }

  // Sleep goal overlay
  const ss = state.settings.sleepSchedule || {};
  const addSleepBlock = (topPx, heightPx, label, inBed) => {
    if (heightPx <= 0) return;
    const b = document.createElement("div");
    b.className = "sleep-block" + (inBed ? " in-bed" : "");
    b.style.top    = topPx + "px";
    b.style.height = heightPx + "px";
    b.textContent  = label;
    tl.appendChild(b);
  };
  if (ss.wakeTime) {
    // Morning carry-over: 12am → wake time (last night's sleep bleeding into today)
    const [wH, wM] = ss.wakeTime.split(":").map(Number);
    const wakePx = wH * HOUR_PX + (wM / 60) * HOUR_PX;
    if (wakePx > 0) addSleepBlock(0, wakePx, "💤 Asleep", false);
  }
  if (ss.bedtime) {
    // Evening: bedtime → midnight
    const [bH, bM] = ss.bedtime.split(":").map(Number);
    const bedPx      = bH * HOUR_PX + (bM / 60) * HOUR_PX;
    const midnightPx = END_HOUR * HOUR_PX;
    if (ss.lightsOut) {
      const [lH, lM] = ss.lightsOut.split(":").map(Number);
      const lightsPx = lH * HOUR_PX + (lM / 60) * HOUR_PX;
      addSleepBlock(bedPx,    lightsPx - bedPx,    "🛏 In bed",  true);
      addSleepBlock(lightsPx, midnightPx - lightsPx, "💤 Asleep", false);
    } else {
      addSleepBlock(bedPx, midnightPx - bedPx, "💤 Asleep", false);
    }
  }

  // "Now" line
  const now = new Date();
  const nowH = now.getHours(), nowM = now.getMinutes();
  if (nowH >= START_HOUR && nowH <= END_HOUR) {
    const line = document.createElement("div");
    line.className = "tl-now";
    line.style.top = ((nowH - START_HOUR) * HOUR_PX + (nowM / 60) * HOUR_PX) + "px";
    tl.appendChild(line);
  }

  // Task blocks
  const fmtT = (h, m) => {
    const dh = h === 0 ? 12 : h > 12 ? h - 12 : h;
    return `${dh}:${String(m).padStart(2, "0")}${h < 12 ? "am" : "pm"}`;
  };

  tasks.forEach(task => {
    const [th, tm] = (task.time || "08:00").split(":").map(Number);
    if (th < START_HOUR || th > END_HOUR) return;

    const topPx    = (th - START_HOUR) * HOUR_PX + (tm / 60) * HOUR_PX;
    const heightPx = Math.max(24, ((task.duration || 30) / 60) * HOUR_PX);
    const color    = CAT_COLORS[task.category] || CAT_COLORS.other;

    const block = document.createElement("div");
    block.className = "task-block" + (task.done ? " done" : "");
    block.style.top    = topPx + "px";
    block.style.height = heightPx + "px";
    block.style.background = color;

    const titleEl = document.createElement("div");
    titleEl.className = "task-block-title";
    titleEl.textContent = task.title;
    block.appendChild(titleEl);

    if (heightPx >= 40) {
      const endMin = th * 60 + tm + (task.duration || 30);
      const timeEl = document.createElement("div");
      timeEl.className = "task-block-time";
      timeEl.textContent = `${fmtT(th, tm)} – ${fmtT(Math.floor(endMin / 60) % 24, endMin % 60)}`;
      block.appendChild(timeEl);
    }

    // Tap → toggle done
    block.addEventListener("click", () => {
      task.done = !task.done;
      save();
      renderTimeline(true);
    });

    // Long-press → delete
    let pressTimer;
    block.addEventListener("touchstart", () => {
      pressTimer = setTimeout(() => {
        if (confirm(`Delete "${task.title}"?`)) {
          state.tasks = state.tasks.filter(t => t.id !== task.id);
          save(); renderTimeline(true);
        }
      }, 700);
    }, { passive: true });
    block.addEventListener("touchend",  () => clearTimeout(pressTimer));
    block.addEventListener("touchmove", () => clearTimeout(pressTimer), { passive: true });

    tl.appendChild(block);
  });

  // Habit blocks
  const habitsOnDay  = (state.habits || []).filter(h => habitAppliesOnDate(h, selectedDate) && h.time);
  const dayHabitDone = (getDay(selectedDate).habitDone || {});

  habitsOnDay.forEach(habit => {
    const [th, tm] = (habit.time || "08:00").split(":").map(Number);
    if (th < START_HOUR || th > END_HOUR) return;
    const topPx    = (th - START_HOUR) * HOUR_PX + (tm / 60) * HOUR_PX;
    const heightPx = Math.max(24, ((habit.duration || 30) / 60) * HOUR_PX);
    const color    = CAT_COLORS[habit.sub] || CAT_COLORS[habit.cat] || CAT_COLORS.other;
    const done     = !!dayHabitDone[habit.id];

    const block = document.createElement("div");
    block.className = "task-block habit-block" + (done ? " done" : "");
    block.style.top    = topPx + "px";
    block.style.height = heightPx + "px";
    block.style.background = color;

    const titleEl = document.createElement("div");
    titleEl.className = "task-block-title";
    titleEl.textContent = "↻ " + habit.title;
    block.appendChild(titleEl);

    if (heightPx >= 40) {
      const endMin = th * 60 + tm + (habit.duration || 30);
      const timeEl = document.createElement("div");
      timeEl.className = "task-block-time";
      timeEl.textContent = `${fmtT(th, tm)} – ${fmtT(Math.floor(endMin / 60) % 24, endMin % 60)}`;
      block.appendChild(timeEl);
    }

    block.addEventListener("click", () => {
      const hd = { ...(getDay(selectedDate).habitDone || {}) };
      hd[habit.id] = !hd[habit.id];
      setDay(selectedDate, { habitDone: hd });
      renderTimeline(true);
      renderSubSections();
    });
    let hPressTimer;
    block.addEventListener("touchstart", () => {
      hPressTimer = setTimeout(() => {
        if (confirm(`Delete habit "${habit.title}"?\nThis removes it from all days.`)) {
          state.habits = (state.habits || []).filter(h => h.id !== habit.id);
          save(); renderTimeline(true); renderSubSections();
        }
      }, 700);
    }, { passive: true });
    block.addEventListener("touchend",  () => clearTimeout(hPressTimer));
    block.addEventListener("touchmove", () => clearTimeout(hPressTimer), { passive: true });

    tl.appendChild(block);
  });

  // Empty state
  if (tasks.length === 0 && habitsOnDay.length === 0) {
    const empty = document.createElement("div");
    empty.className = "tl-empty";
    empty.textContent = "Nothing scheduled. Tap + to add.";
    tl.appendChild(empty);
  }

  // Scroll so current time is visible (skipped when preserving scroll position)
  if (!preserveScroll) {
    const wrap = document.querySelector(".timeline-wrap");
    if (wrap) {
      const target = nowH >= START_HOUR
        ? Math.max(0, (nowH - START_HOUR - 1) * HOUR_PX)
        : (7 - START_HOUR) * HOUR_PX;
      wrap.scrollTop = target;
    }
  }
}

/* ---------- sub-section rendering ---------- */
const ALL_SUBS = [
  ["health","exercise"], ["health","sleep"], ["health","nutrition"],
  ["lifestyle","hobbies"], ["lifestyle","environment"], ["lifestyle","social"], ["lifestyle","chores"],
  ["work","occupation"], ["work","education"]
];

function renderSubSections() {
  const todayK = todayKey();

  ALL_SUBS.forEach(([cat, sub]) => {
    const listEl = document.getElementById(`itemlist-${cat}-${sub}`);
    if (!listEl) return;

    const habits   = (state.habits || []).filter(h => h.cat === cat && h.sub === sub);
    const todayTasks = (state.tasks || []).filter(t => t.date === todayK && t.category === sub);

    if (!habits.length && !todayTasks.length) {
      listEl.innerHTML = `<div class="cat-empty">No habits or tasks yet.<br>Tap + to add one.</div>`;
      return;
    }

    let html = "";

    if (habits.length) {
      html += `<p class="item-section-title">Habits</p>`;
      habits.forEach(habit => {
        const doneToday  = !!(getDay(todayK).habitDone || {})[habit.id];
        const repeatLabel = habit.repeat === "daily" ? "Daily" : formatWeekDays(habit.days);
        const timeLabel   = habit.time ? ` · ${fmtT12(habit.time)}` : "";
        html += `
          <div class="habit-row${doneToday ? " done" : ""}" data-habit-id="${habit.id}">
            <button class="habit-check${doneToday ? " checked" : ""}" data-habit-id="${habit.id}" aria-label="Toggle">${doneToday ? "✓" : ""}</button>
            <div class="habit-info">
              <div class="habit-name">${habit.title}</div>
              <div class="habit-meta">↻ ${repeatLabel}${timeLabel}</div>
            </div>
          </div>`;
      });
    }

    if (todayTasks.length) {
      html += `<p class="item-section-title">Today's Tasks</p>`;
      todayTasks.forEach(task => {
        html += `
          <div class="task-row${task.done ? " done" : ""}" data-task-id="${task.id}">
            <button class="habit-check${task.done ? " checked" : ""}" data-task-id="${task.id}" aria-label="Toggle">${task.done ? "✓" : ""}</button>
            <div class="habit-info">
              <div class="habit-name">${task.title}</div>
              <div class="habit-meta">📅 Today · ${fmtT12(task.time || "08:00")} · ${task.duration || 30} min</div>
            </div>
          </div>`;
      });
    }

    listEl.innerHTML = html;

    // Habit toggle
    listEl.querySelectorAll(".habit-check[data-habit-id]").forEach(btn => {
      btn.addEventListener("click", e => {
        e.stopPropagation();
        const hd = { ...(getDay(todayK).habitDone || {}) };
        hd[btn.dataset.habitId] = !hd[btn.dataset.habitId];
        setDay(todayK, { habitDone: hd });
        renderSubSections();
        if (document.getElementById("cat-schedule")?.style.display !== "none") renderTimeline(true);
      });
    });

    // Task toggle
    listEl.querySelectorAll(".habit-check[data-task-id]").forEach(btn => {
      btn.addEventListener("click", e => {
        e.stopPropagation();
        const task = (state.tasks || []).find(t => t.id === btn.dataset.taskId);
        if (task) { task.done = !task.done; save(); renderSubSections(); }
        if (document.getElementById("cat-schedule")?.style.display !== "none") renderTimeline(true);
      });
    });

    // Habit long-press → delete
    listEl.querySelectorAll(".habit-row[data-habit-id]").forEach(row => {
      let t;
      row.addEventListener("touchstart", () => {
        t = setTimeout(() => {
          const h = (state.habits || []).find(x => x.id === row.dataset.habitId);
          if (confirm(`Delete habit "${h?.title}"?\nThis removes it from all days.`)) {
            state.habits = (state.habits || []).filter(x => x.id !== row.dataset.habitId);
            save(); renderSubSections(); renderTimeline(true);
          }
        }, 700);
      }, { passive: true });
      row.addEventListener("touchend",  () => clearTimeout(t));
      row.addEventListener("touchmove", () => clearTimeout(t), { passive: true });
    });

    // Task long-press → delete
    listEl.querySelectorAll(".task-row[data-task-id]").forEach(row => {
      let t;
      row.addEventListener("touchstart", () => {
        t = setTimeout(() => {
          const task = (state.tasks || []).find(x => x.id === row.dataset.taskId);
          if (confirm(`Delete task "${task?.title}"?`)) {
            state.tasks = (state.tasks || []).filter(x => x.id !== row.dataset.taskId);
            save(); renderSubSections(); renderTimeline(true);
          }
        }, 700);
      }, { passive: true });
      row.addEventListener("touchend",  () => clearTimeout(t));
      row.addEventListener("touchmove", () => clearTimeout(t), { passive: true });
    });
  });
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

  // sleep schedule
  const ssSaved = state.settings.sleepSchedule || {};
  const elBedtime    = document.getElementById("setBedtime");
  const elLightsOut  = document.getElementById("setLightsOut");
  const elWakeTime   = document.getElementById("setWakeTime");
  if (elBedtime)   elBedtime.value   = ssSaved.bedtime   || "";
  if (elLightsOut) elLightsOut.value = ssSaved.lightsOut || "";
  if (elWakeTime)  elWakeTime.value  = ssSaved.wakeTime  || "";
  document.getElementById("saveSleepSchedule")?.addEventListener("click", () => {
    state.settings.sleepSchedule = {
      bedtime:   elBedtime?.value   || "",
      lightsOut: elLightsOut?.value || "",
      wakeTime:  elWakeTime?.value  || ""
    };
    save();
    flash("Sleep schedule saved");
  });

  // task / habit sheet
  const taskSheet = document.getElementById("taskSheet");

  function openTaskSheet(defaultCat, forceType) {
    // Reset type
    _sheetType = forceType || "task";
    _habitRepeat = "daily";
    _habitDays = [];
    document.querySelectorAll("#sheetTypeSeg button").forEach(b =>
      b.classList.toggle("active", b.dataset.type === _sheetType));
    document.getElementById("taskSheetTitle").textContent = _sheetType === "habit" ? "Add habit" : "Add task";
    document.getElementById("saveTaskBtn").textContent    = _sheetType === "habit" ? "Add habit" : "Add task";
    document.getElementById("habitRepeatSection").style.display = _sheetType === "habit" ? "" : "none";
    document.getElementById("weekdayPicker").style.display = "none";
    document.querySelectorAll("#repeatSeg button").forEach(b =>
      b.classList.toggle("active", b.dataset.repeat === "daily"));
    document.querySelectorAll(".day-pick-btn").forEach(b => b.classList.remove("active"));
    // Reset fields
    const n = new Date();
    const hh = String(n.getHours()).padStart(2, "0");
    const mm = String(Math.round(n.getMinutes() / 15) * 15 % 60).padStart(2, "0");
    document.getElementById("taskTime").value  = `${hh}:${mm}`;
    document.getElementById("taskTitle").value = "";
    if (defaultCat) document.getElementById("taskCategory").value = defaultCat;
    taskSheet.classList.add("open");
  }

  // Type toggle (Task / Habit)
  document.querySelectorAll("#sheetTypeSeg button").forEach(btn => {
    btn.addEventListener("click", () => {
      _sheetType = btn.dataset.type;
      document.querySelectorAll("#sheetTypeSeg button").forEach(b => b.classList.remove("active"));
      btn.classList.add("active");
      document.getElementById("taskSheetTitle").textContent = _sheetType === "habit" ? "Add habit" : "Add task";
      document.getElementById("saveTaskBtn").textContent    = _sheetType === "habit" ? "Add habit" : "Add task";
      document.getElementById("habitRepeatSection").style.display = _sheetType === "habit" ? "" : "none";
    });
  });

  // Repeat toggle (Daily / Weekly)
  document.querySelectorAll("#repeatSeg button").forEach(btn => {
    btn.addEventListener("click", () => {
      _habitRepeat = btn.dataset.repeat;
      document.querySelectorAll("#repeatSeg button").forEach(b => b.classList.remove("active"));
      btn.classList.add("active");
      document.getElementById("weekdayPicker").style.display = _habitRepeat === "weekly" ? "" : "none";
    });
  });

  // Weekday picker
  document.querySelectorAll(".day-pick-btn").forEach(btn => {
    btn.addEventListener("click", () => {
      const day = parseInt(btn.dataset.day);
      if (_habitDays.includes(day)) {
        _habitDays = _habitDays.filter(d => d !== day);
        btn.classList.remove("active");
      } else {
        _habitDays.push(day);
        btn.classList.add("active");
      }
    });
  });

  document.getElementById("addTaskBtn").addEventListener("click", () => openTaskSheet(null));

  // sub-section + buttons — default to whichever sub-tab is active
  document.querySelectorAll(".sub-add-btn").forEach(btn => {
    btn.addEventListener("click", () => {
      const cat = btn.dataset.cat;
      const activeSub = document.querySelector(`#subtabs-${cat} .sub-btn.active`);
      const defaultCat = activeSub ? activeSub.dataset.sub : cat;
      openTaskSheet(defaultCat);
    });
  });
  document.getElementById("closeTaskSheet").addEventListener("click", () => taskSheet.classList.remove("open"));
  taskSheet.addEventListener("click", (e) => { if (e.target === taskSheet) taskSheet.classList.remove("open"); });

  document.getElementById("saveTaskBtn").addEventListener("click", () => {
    const title    = document.getElementById("taskTitle").value.trim();
    const time     = document.getElementById("taskTime").value;
    const duration = parseInt(document.getElementById("taskDuration").value) || 30;
    const category = document.getElementById("taskCategory").value;
    if (!title) { flash("Enter a name"); return; }
    if (!time)  { flash("Pick a time"); return; }

    if (_sheetType === "habit") {
      if (_habitRepeat === "weekly" && _habitDays.length === 0) { flash("Pick at least one day"); return; }
      const cat = SUB_TO_CAT[category] || "other";
      if (!state.habits) state.habits = [];
      state.habits.push({
        id: Date.now().toString(36), title,
        cat, sub: category, time, duration,
        repeat: _habitRepeat,
        days: _habitRepeat === "weekly" ? [..._habitDays] : [],
        createdAt: Date.now()
      });
    } else {
      if (!state.tasks) state.tasks = [];
      state.tasks.push({ id: Date.now().toString(36), title, date: selectedDate, time, duration, category, done: false });
    }

    save();
    taskSheet.classList.remove("open");
    renderSubSections();
    renderTimeline();
  });

  // category bar (bottom) — generic, no hardcoding needed for new tabs
  document.querySelectorAll(".cat-btn").forEach(btn => {
    btn.addEventListener("click", () => {
      const cat = btn.dataset.cat;
      document.querySelectorAll(".cat-btn").forEach(b => b.classList.remove("active"));
      btn.classList.add("active");
      document.querySelectorAll("[id^='cat-']").forEach(el => el.style.display = "none");
      document.querySelectorAll("[id^='subtabs-']").forEach(el => el.style.display = "none");
      document.getElementById(`cat-${cat}`).style.display = "";
      const subtabs = document.getElementById(`subtabs-${cat}`);
      if (subtabs) subtabs.style.display = "";
      if (cat === "schedule") { renderMonthCalendar(); renderTimeline(); }
    });
  });

  // sub-tabs (top)
  document.querySelectorAll(".sub-btn").forEach(btn => {
    btn.addEventListener("click", () => {
      const cat = btn.dataset.cat;
      const sub = btn.dataset.sub;
      document.querySelectorAll(`#subtabs-${cat} .sub-btn`).forEach(b => b.classList.remove("active"));
      btn.classList.add("active");
      document.querySelectorAll(`#cat-${cat} .sub-section`).forEach(s => s.style.display = "none");
      document.getElementById(`sub-${cat}-${sub}`).style.display = "";
    });
  });

  // hamburger menu
  const menuBtn = document.getElementById("menuBtn");
  const menuDropdown = document.getElementById("menuDropdown");
  menuBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    menuDropdown.classList.toggle("open");
  });
  document.addEventListener("click", () => menuDropdown.classList.remove("open"));
  document.querySelectorAll(".menu-item").forEach(item => {
    item.addEventListener("click", () => {
      document.querySelectorAll(".screen").forEach(s => s.classList.remove("active"));
      document.getElementById("screen-" + item.dataset.screen).classList.add("active");
      document.querySelectorAll(".menu-item").forEach(x => x.classList.remove("active"));
      item.classList.add("active");
      menuDropdown.classList.remove("open");
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
renderMonthCalendar();
renderTimeline();
maybeShowInstall();
handleDeepLink();
initAuth();
setInterval(() => render(), 60_000);
document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible") pullNow(); });
