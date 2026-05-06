#!/usr/bin/env node
/**
 * Manifest MCP server
 * ───────────────────
 * Exposes your Manifest fitness data (stored in Supabase) as MCP tools so
 * Claude Desktop can read and write it conversationally.
 *
 * Required env vars:
 *   SUPABASE_URL   — your Supabase project URL
 *   SUPABASE_KEY   — your Supabase anon key
 *   SYNC_CODE      — the same sync code you set in the Manifest app
 *
 * Wire up in claude_desktop_config.json — see README.md.
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { createClient } from "@supabase/supabase-js";

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_KEY;
const SYNC_CODE = process.env.SYNC_CODE;

if (!SUPABASE_URL || !SUPABASE_KEY || !SYNC_CODE) {
  console.error("Manifest MCP: missing SUPABASE_URL, SUPABASE_KEY, or SYNC_CODE env vars.");
  process.exit(1);
}

const sb = createClient(SUPABASE_URL, SUPABASE_KEY, {
  auth: { persistSession: false }
});

/* ───────── data helpers ───────── */

const todayKey = (d = new Date()) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;

const addDays = (date, n) => {
  const d = new Date(date);
  d.setDate(d.getDate() + n);
  return d;
};

async function loadState() {
  const { data, error } = await sb
    .from("manifest_data")
    .select("data")
    .eq("sync_code", SYNC_CODE)
    .maybeSingle();
  if (error) throw new Error(error.message);
  const empty = { settings: { name: "", waterGoal: 8, sleepGoal: 8 }, days: {} };
  return data?.data ? { ...empty, ...data.data,
    settings: { ...empty.settings, ...(data.data.settings || {}) } } : empty;
}

async function saveState(state) {
  const { error } = await sb
    .from("manifest_data")
    .upsert(
      { sync_code: SYNC_CODE, data: state, updated_at: new Date().toISOString() },
      { onConflict: "sync_code" }
    );
  if (error) throw new Error(error.message);
}

async function patchToday(patch) {
  const state = await loadState();
  const k = todayKey();
  const cur = state.days[k] || {};
  const next = { ...cur, ...patch };
  Object.keys(next).forEach((kk) => next[kk] === undefined && delete next[kk]);
  state.days[k] = next;
  await saveState(state);
  return { date: k, ...next };
}

const isWorkoutDone = (d) => !!(d.workout && d.workout.type);
const isWaterDone = (d, goal) => !!(d.water && d.water.glasses >= goal);
const isSleepDone = (d) => !!(d.sleep && d.sleep.hours > 0);
const isFoodDone = (d) => !!(d.nutrition && d.nutrition.rating);
const dayCompletion = (d, goal) =>
  (isWorkoutDone(d) ? 1 : 0) +
  (isWaterDone(d, goal) ? 1 : 0) +
  (isSleepDone(d) ? 1 : 0) +
  (isFoodDone(d) ? 1 : 0);

function streakFor(state, predicate) {
  let n = 0;
  let cursor = new Date();
  const today = state.days[todayKey(cursor)] || {};
  if (!predicate(today)) cursor = addDays(cursor, -1);
  while (true) {
    const d = state.days[todayKey(cursor)] || {};
    if (predicate(d)) {
      n++;
      cursor = addDays(cursor, -1);
    } else break;
    if (n > 3650) break; // safety
  }
  return n;
}

/* ───────── MCP server ───────── */

const server = new Server(
  { name: "manifest", version: "1.0.0" },
  { capabilities: { tools: {} } }
);

const TOOLS = [
  {
    name: "get_today",
    description: "Get today's Manifest snapshot: workout, water, sleep, nutrition, and how many of the 4 daily habits are done.",
    inputSchema: { type: "object", properties: {}, required: [] }
  },
  {
    name: "get_streak",
    description: "Get the current streak (in days) for one habit or for 'all' (all 4 habits done same day).",
    inputSchema: {
      type: "object",
      properties: {
        habit: { type: "string", enum: ["workout", "water", "sleep", "nutrition", "all"] }
      },
      required: ["habit"]
    }
  },
  {
    name: "get_history",
    description: "Get the last N days of habit data. Default 30.",
    inputSchema: {
      type: "object",
      properties: { days: { type: "integer", minimum: 1, maximum: 365 } },
      required: []
    }
  },
  {
    name: "log_workout",
    description: "Log today's workout. Type must be Strength, Cardio, Mobility, or Other.",
    inputSchema: {
      type: "object",
      properties: {
        type: { type: "string", enum: ["Strength", "Cardio", "Mobility", "Other"] },
        note: { type: "string" }
      },
      required: ["type"]
    }
  },
  {
    name: "log_water",
    description: "Add (or subtract) glasses of water from today's count. Use a negative number to undo.",
    inputSchema: {
      type: "object",
      properties: { glasses: { type: "integer", minimum: -20, maximum: 20 } },
      required: ["glasses"]
    }
  },
  {
    name: "set_water",
    description: "Set today's total water glasses to an exact number.",
    inputSchema: {
      type: "object",
      properties: { glasses: { type: "integer", minimum: 0, maximum: 50 } },
      required: ["glasses"]
    }
  },
  {
    name: "log_sleep",
    description: "Log last night's sleep: hours (0-14) and a quality rating (0-5).",
    inputSchema: {
      type: "object",
      properties: {
        hours: { type: "number", minimum: 0, maximum: 14 },
        quality: { type: "integer", minimum: 0, maximum: 5 }
      },
      required: ["hours"]
    }
  },
  {
    name: "log_nutrition",
    description: "Log how today's eating went.",
    inputSchema: {
      type: "object",
      properties: { rating: { type: "string", enum: ["good", "ok", "off"] } },
      required: ["rating"]
    }
  },
  {
    name: "set_goal",
    description: "Update a daily goal: water (in glasses) or sleep (in hours).",
    inputSchema: {
      type: "object",
      properties: {
        which: { type: "string", enum: ["water", "sleep"] },
        value: { type: "number" }
      },
      required: ["which", "value"]
    }
  },
  {
    name: "get_settings",
    description: "Read the user's current goals and name.",
    inputSchema: { type: "object", properties: {}, required: [] }
  }
];

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const { name, arguments: args = {} } = req.params;
  try {
    const text = await dispatch(name, args);
    return { content: [{ type: "text", text }] };
  } catch (e) {
    return { content: [{ type: "text", text: `Error: ${e.message}` }], isError: true };
  }
});

async function dispatch(name, args) {
  switch (name) {
    case "get_today": {
      const state = await loadState();
      const k = todayKey();
      const d = state.days[k] || {};
      const goal = state.settings.waterGoal || 8;
      return JSON.stringify({
        date: k,
        workout: d.workout || null,
        water: { glasses: (d.water?.glasses) || 0, goal },
        sleep: d.sleep || null,
        nutrition: d.nutrition || null,
        completion: dayCompletion(d, goal)
      }, null, 2);
    }
    case "get_streak": {
      const state = await loadState();
      const goal = state.settings.waterGoal || 8;
      const fns = {
        workout: isWorkoutDone,
        water: (d) => isWaterDone(d, goal),
        sleep: isSleepDone,
        nutrition: isFoodDone,
        all: (d) => dayCompletion(d, goal) === 4
      };
      const fn = fns[args.habit];
      if (!fn) throw new Error("habit must be workout|water|sleep|nutrition|all");
      const n = streakFor(state, fn);
      return JSON.stringify({ habit: args.habit, streak_days: n });
    }
    case "get_history": {
      const state = await loadState();
      const goal = state.settings.waterGoal || 8;
      const days = Math.max(1, Math.min(365, args.days || 30));
      const out = [];
      const today = new Date();
      for (let i = days - 1; i >= 0; i--) {
        const dt = addDays(today, -i);
        const k = todayKey(dt);
        const d = state.days[k] || {};
        out.push({ date: k, ...d, completion: dayCompletion(d, goal) });
      }
      return JSON.stringify(out, null, 2);
    }
    case "log_workout": {
      const r = await patchToday({ workout: { type: args.type, note: args.note || "", at: Date.now() } });
      return `Workout logged: ${args.type}${args.note ? ` — ${args.note}` : ""}`;
    }
    case "log_water": {
      const state = await loadState();
      const k = todayKey();
      const cur = state.days[k]?.water?.glasses || 0;
      const next = Math.max(0, cur + (args.glasses ?? 0));
      const r = await patchToday({ water: { glasses: next } });
      return `Water: ${next} / ${state.settings.waterGoal || 8} glasses`;
    }
    case "set_water": {
      const r = await patchToday({ water: { glasses: Math.max(0, args.glasses) } });
      const state = await loadState();
      return `Water set to ${args.glasses} / ${state.settings.waterGoal || 8} glasses`;
    }
    case "log_sleep": {
      const q = Math.max(0, Math.min(5, args.quality || 0));
      const r = await patchToday({ sleep: { hours: args.hours, quality: q } });
      return `Sleep logged: ${args.hours}h${q ? ` · quality ${q}/5` : ""}`;
    }
    case "log_nutrition": {
      const r = await patchToday({ nutrition: { rating: args.rating } });
      return `Nutrition logged: ${args.rating}`;
    }
    case "set_goal": {
      const state = await loadState();
      if (args.which === "water") state.settings.waterGoal = Math.max(1, args.value | 0);
      else if (args.which === "sleep") state.settings.sleepGoal = Math.max(3, args.value);
      else throw new Error("which must be water|sleep");
      await saveState(state);
      return `Goal updated: ${args.which} = ${args.value}`;
    }
    case "get_settings": {
      const state = await loadState();
      return JSON.stringify(state.settings, null, 2);
    }
    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

const transport = new StdioServerTransport();
await server.connect(transport);
console.error("Manifest MCP server ready.");
