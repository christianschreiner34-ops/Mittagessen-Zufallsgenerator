// Mittagsrad. Die beiden Werte unten sind öffentlich und dürfen im Code stehen.
// Wer was sehen und ändern darf, regelt die Datenbank selbst (Row Level Security).
const SUPABASE_URL = "https://hizartknzkaswewamqyf.supabase.co";
const SUPABASE_KEY = "sb_publishable_E40kXVHnlZNEwjYLgtzqcQ_9-JUNxyL";

const db = window.supabase.createClient(SUPABASE_URL, SUPABASE_KEY);
const $ = (id) => document.getElementById(id);

const state = {
  email: null,
  admin: false,
  restaurants: [],
  picks: [],
  members: [],
  attendance: [], // E-Mails, die heute dabei sind
  vetoes: [],
  favorites: [], // {email, restaurant_id}
  ratings: [], // {pick_id, email, thumbs}
  attendanceWeek: [], // {day, email} seit Montag
  weather: null, // { rainy, text }
  rotation: 0,
  spinning: false,
};

const PRICE = { 1: "€", 2: "€€", 3: "€€€" };

function esc(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

function todayBerlin() {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Berlin" }).format(new Date());
}

// ISO-Wochentag in Berlin: 1 = Montag … 7 = Sonntag
function weekdayBerlin() {
  const d = new Intl.DateTimeFormat("en-US", { timeZone: "Europe/Berlin", weekday: "short" }).format(new Date());
  return { Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6, Sun: 7 }[d];
}

// Montag der laufenden Woche in Berlin, wie in der Datenbank (week_start)
function weekStartBerlin() {
  const [y, m, d] = todayBerlin().split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d - (weekdayBerlin() - 1)));
  return dt.toISOString().slice(0, 10);
}

const isVetoed = (pick) => state.vetoes.some((v) => v.pick_id === pick.id);
// Die Ziehung, die für einen Tag gilt: die letzte des Tages. Wurde gegen sie ein Joker
// eingesetzt, ist der Tag wieder offen (ältere, verworfene Ziehungen zählen nicht).
const validPickOn = (day) => {
  const last = state.picks.find((p) => p.pick_date === day);
  return last && !isVetoed(last) ? last : undefined;
};

function formatDate(iso) {
  const [y, m, d] = iso.split("-").map(Number);
  return new Date(y, m - 1, d).toLocaleDateString("de-DE", { weekday: "short", day: "2-digit", month: "2-digit" });
}

function nameOf(email) {
  const m = state.members.find((x) => x.email === email);
  return m?.display_name || (email ? email.split("@")[0] : "?");
}

function setMsg(el, text, kind = "") {
  el.textContent = text;
  el.className = "msg " + kind;
}

// ---------- Anmeldung ----------

$("login-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const email = $("login-email").value.trim().toLowerCase();
  const msg = $("login-msg");
  setMsg(msg, "Wird geschickt …");
  const { error } = await db.auth.signInWithOtp({
    email,
    options: { emailRedirectTo: location.origin + location.pathname },
  });
  if (error) {
    const notAllowed = /database error|not allowed|freigegeben|signups/i.test(error.message);
    setMsg(msg, notAllowed ? "Diese Adresse ist nicht freigegeben. Frag Christian, ob er dich einträgt." : "Hat nicht geklappt: " + error.message, "err");
  } else {
    setMsg(msg, "Schau in dein Postfach und klick auf den Link. Du kannst dieses Fenster schließen.", "ok");
  }
});

$("logout").addEventListener("click", async () => {
  await db.auth.signOut();
  location.reload();
});

db.auth.onAuthStateChange((_event, session) => {
  if (session) start(session);
  if (!session) show("login");
});

function show(view) {
  $("view-login").classList.toggle("hidden", view !== "login");
  $("view-app").classList.toggle("hidden", view !== "app");
}

async function start(session) {
  if (state.email) return;
  state.email = session.user.email.toLowerCase();
  show("app");
  await loadAll();
  const me = state.members.find((m) => m.email === state.email);
  if (!me) {
    document.querySelector("#view-app").innerHTML = '<main class="login"><h1>Kein Zugang</h1><p class="muted">Deine Adresse ist nicht (mehr) freigegeben.</p><button class="btn btn--secondary" onclick="db.auth.signOut().then(()=>location.reload())">Abmelden</button></main>';
    return;
  }
  state.admin = me.is_admin;
  document.querySelectorAll(".admin-only").forEach((el) => el.classList.toggle("hidden", !state.admin));
  renderAll();
  // Das Rad erst neu zeichnen, wenn die Schrift geladen ist
  document.fonts?.ready.then(() => renderWheel());
  loadWeather();
}

// ---------- Daten ----------

async function loadAll() {
  const [r, p, m, a, v, f, rt] = await Promise.all([
    db.from("restaurants").select("*").order("name"),
    db.from("picks").select("*").order("created_at", { ascending: false }).limit(300),
    db.from("members").select("*").order("email"),
    db.from("attendance").select("day, email").gte("day", weekStartBerlin()),
    db.from("vetoes").select("*").order("created_at", { ascending: false }).limit(300),
    db.from("favorites").select("email, restaurant_id"),
    db.from("ratings").select("pick_id, email, thumbs").limit(5000),
  ]);
  state.restaurants = r.data || [];
  state.picks = p.data || [];
  state.members = m.data || [];
  state.attendanceWeek = a.data || [];
  state.attendance = state.attendanceWeek.filter((x) => x.day === todayBerlin()).map((x) => x.email);
  state.vetoes = v.data || [];
  state.favorites = f.data || [];
  state.ratings = rt.data || [];
}

function renderAll() {
  renderCuisineOptions();
  renderCrew();
  renderWheel();
  renderToday();
  renderList();
  renderHistory();
  renderMembers();
}

// ---------- Tabs ----------

document.querySelectorAll(".tab").forEach((btn) =>
  btn.addEventListener("click", () => {
    document.querySelectorAll(".tab").forEach((b) => b.classList.toggle("active", b === btn));
    document.querySelectorAll(".tab-page").forEach((p) => p.classList.toggle("hidden", p.id !== "tab-" + btn.dataset.tab));
  })
);

// ---------- Glücksrad ----------

// Restaurants der letzten n Tage, an denen gezogen wurde (heute zählt nicht mit).
// So ist am Montag "gestern" der Freitag.
function recentlyEaten(n) {
  if (n <= 0) return new Map();
  const today = todayBerlin();
  const days = [...new Set(state.picks.map((p) => p.pick_date).filter((d) => d < today))].slice(0, n);
  const result = new Map();
  for (const day of days) {
    // pro Tag zählt nur die gültige Ziehung, also das, wo man wirklich war
    const last = validPickOn(day);
    if (last) result.set(last.restaurant_id, day);
  }
  return result;
}

function candidates() {
  const exclude = recentlyEaten(Number($("f-exclude").value));
  const cuisine = $("f-cuisine").value;
  const maxPrice = Number($("f-price").value);
  const maxWalk = $("f-walk").value ? Number($("f-walk").value) : null;
  const crewVeg = crewNeedsVeg();
  const veg = $("f-veg").value === "1" || crewVeg;
  const day = weekdayBerlin();
  const closed = state.restaurants.filter((r) => r.active && (r.closed_days || []).includes(day));
  // Läden, gegen die heute ein Joker eingesetzt wurde, kommen heute nicht mehr dran
  const today = todayBerlin();
  const vetoed = new Set(state.picks.filter((p) => p.pick_date === today && isVetoed(p)).map((p) => p.restaurant_id));
  const list = state.restaurants.filter(
    (r) =>
      r.active &&
      !exclude.has(r.id) &&
      !vetoed.has(r.id) &&
      !(r.closed_days || []).includes(day) &&
      (!rainBlocks() || r.walk_minutes == null || r.walk_minutes <= RAIN_MAX_WALK) &&
      (!cuisine || r.cuisine === cuisine) &&
      (!r.price || r.price <= maxPrice) &&
      (maxWalk === null || r.walk_minutes == null || r.walk_minutes <= maxWalk) &&
      (!veg || r.vegetarian)
  );
  return { list, exclude, closed, vetoed, crewVeg };
}

["f-exclude", "f-cuisine", "f-price", "f-walk", "f-veg", "f-weight", "rain-ok"].forEach((id) => $(id).addEventListener("change", renderWheel));
// Segmentierte Auswahl (wie bei iOS) für Filter mit wenigen Möglichkeiten.
// Das <select> bleibt die Quelle der Wahrheit, die Knöpfe setzen nur seinen Wert.
document.querySelectorAll("select.seg-source").forEach((sel) => {
  const group = document.createElement("div");
  group.className = "seg";
  group.setAttribute("role", "radiogroup");
  group.setAttribute("aria-labelledby", sel.getAttribute("aria-labelledby"));
  const buttons = [...sel.options].map((opt) => {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "seg-btn";
    b.setAttribute("role", "radio");
    b.textContent = opt.textContent;
    b.addEventListener("click", () => {
      if (sel.value === opt.value) return;
      sel.value = opt.value;
      sel.dispatchEvent(new Event("change"));
    });
    group.appendChild(b);
    return { b, opt };
  });
  const sync = () => {
    buttons.forEach(({ b, opt }, i) => {
      const on = opt.value === sel.value;
      b.setAttribute("aria-checked", on);
      b.tabIndex = on ? 0 : -1;
      if (on) group.style.setProperty("--i", i);
    });
  };
  group.style.setProperty("--n", buttons.length);
  group.addEventListener("keydown", (e) => {
    const step = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 }[e.key];
    if (!step) return;
    e.preventDefault();
    const i = (sel.selectedIndex + step + buttons.length) % buttons.length;
    buttons[i].b.click();
    buttons[i].b.focus();
  });
  sel.addEventListener("change", sync);
  sel.hidden = true;
  sel.insertAdjacentElement("afterend", group);
  sync();
});


// ---------- Felder im Rad: Gewichtung und Überraschungsfeld ----------

const DAY_MS = 86400000;
function daysSince(iso) {
  const [y, m, d] = iso.split("-").map(Number);
  const [ty, tm, td] = todayBerlin().split("-").map(Number);
  return Math.round((Date.UTC(ty, tm - 1, td) - Date.UTC(y, m - 1, d)) / DAY_MS);
}

function lastVisit() {
  const last = new Map();
  const days = new Set();
  for (const p of state.picks) {
    if (days.has(p.pick_date)) continue;
    days.add(p.pick_date);
    const v = validPickOn(p.pick_date);
    if (v && !last.has(v.restaurant_id)) last.set(v.restaurant_id, v.pick_date);
  }
  return last;
}

// Lieblingsläden zählen: von den Leuten, die heute dabei sind, sonst von allen
function favCount(id, all = false) {
  const crew = state.attendance.length && !all ? new Set(state.attendance) : null;
  return state.favorites.filter((f) => f.restaurant_id === id && (!crew || crew.has(f.email))).length;
}

// Gewicht: 1 als Grundwert, je Favorit +0,5, und bis zu +1 für Läden, in denen ihr lange nicht wart
function weightOf(r, last) {
  const since = last.has(r.id) ? daysSince(last.get(r.id)) : 28;
  return 1 + 0.5 * favCount(r.id) + Math.min(1, since / 28);
}

// Überraschungstag: an etwa jedem dritten Tag, für alle gleich (hängt nur am Datum)
function isSurpriseDay() {
  const t = todayBerlin();
  let h = 0;
  for (const ch of t) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return h % 3 === 0;
}

function buildSegments(list) {
  const weighted = $("f-weight").value === "1";
  const last = lastVisit();
  const fresh = list.filter((r) => !last.has(r.id));
  const useSurprise = isSurpriseDay() && fresh.length > 0 && list.length - fresh.length >= 2;
  const named = useSurprise ? list.filter((r) => last.has(r.id)) : list;
  const segs = named.map((r) => ({ ids: [r.id], label: r.name, weight: weighted ? weightOf(r, last) : 1, fresh: !last.has(r.id) }));
  if (useSurprise) segs.push({ ids: fresh.map((r) => r.id), label: "Überraschung", weight: weighted ? 2 : 1, surprise: true });
  // Überraschungsfeld nicht immer ans Ende, sondern zwischen die anderen
  if (useSurprise && segs.length > 2) segs.splice(Math.floor(segs.length / 2), 0, segs.pop());
  return { segs, fresh: fresh.length, useSurprise };
}

function renderCuisineOptions() {
  const cuisines = [...new Set(state.restaurants.map((r) => r.cuisine).filter(Boolean))].sort((a, b) => a.localeCompare(b, "de"));
  const sel = $("f-cuisine");
  const current = sel.value;
  sel.innerHTML = '<option value="">Alle</option>' + cuisines.map((c) => `<option value="${esc(c)}">${esc(c)}</option>`).join("");
  sel.value = cuisines.includes(current) ? current : "";
  $("cuisine-list").innerHTML = cuisines.map((c) => `<option value="${esc(c)}">`).join("");
}

function renderWheel() {
  const { list, exclude, closed, vetoed, crewVeg } = candidates();
  const todays = validPickOn(todayBerlin());
  const { segs, useSurprise, fresh } = buildSegments(list);
  state.segs = segs;
  drawWheel(segs, todays?.restaurant_id);
  const active = state.restaurants.filter((r) => r.active).length;
  const nameList = (ids) => ids.map((id) => state.restaurants.find((x) => x.id === id)?.name).filter(Boolean).join(", ");
  let info = `${list.length} von ${active} Restaurants im Rad.`;
  if (exclude.size) info += ` Nicht dabei, weil es das zuletzt gab: ${nameList([...exclude.keys()])}.`;
  if (closed.length) info += ` Heute Ruhetag: ${closed.map((r) => r.name).join(", ")}.`;
  if (vetoed.size) info += ` Heute per Joker abgelehnt: ${nameList([...vetoed])}.`;
  if (crewVeg) info += " Jemand von euch isst vegetarisch, deshalb nur Läden mit vegetarischer Auswahl.";
  if (rainBlocks()) info += ` Wegen Regen nur Läden bis ${RAIN_MAX_WALK} Minuten.`;
  if (useSurprise) info += ` Heute ist Überraschungstag: Hinter dem Feld „Überraschung“ steckt einer von ${fresh} Läden, in denen ihr noch nie wart.`;
  $("f-info").textContent = info;
  $("spin").disabled = list.length === 0 || state.spinning;
}

// Rad in den Farben der Seite: Weiß und Hellgrau im Wechsel, Mint nur für das Gewinnerfeld.
const darkMode = window.matchMedia("(prefers-color-scheme: dark)").matches;
const WHEEL = darkMode
  ? { a: "#1f1f1f", b: "#2a2a2a", ink: "#f1f1f1", line: "rgba(241,241,241,.16)", win: "#145a3d", winInk: "#ffffff" }
  : { a: "#ffffff", b: "#e9e9e9", ink: "#232323", line: "rgba(35,35,35,.16)", win: "#0b3d2a", winInk: "#ffffff" };

function drawWheel(segs, winnerId = null) {
  const c = $("wheel");
  const ctx = c.getContext("2d");
  const size = c.width;
  const R = size / 2;
  const r = R - 4;
  ctx.clearRect(0, 0, size, size);
  ctx.save();
  ctx.translate(R, R);

  if (segs.length === 0) {
    ctx.beginPath();
    ctx.arc(0, 0, r, 0, Math.PI * 2);
    ctx.fillStyle = WHEEL.a;
    ctx.fill();
    ctx.strokeStyle = WHEEL.line;
    ctx.lineWidth = 2;
    ctx.stroke();
    ctx.fillStyle = WHEEL.ink;
    ctx.font = "500 30px 'Host Grotesk', sans-serif";
    ctx.textAlign = "center";
    ctx.fillText(state.restaurants.length ? "Nichts passt zu den Filtern" : "Noch keine Restaurants", 0, 10);
    ctx.restore();
    return;
  }

  const n = segs.length;
  const total = segs.reduce((s, x) => s + x.weight, 0);
  let acc = 0;
  segs.forEach((sg, i) => {
    const seg = (Math.PI * 2 * sg.weight) / total;
    const a0 = state.rotation + acc;
    acc += seg;
    const isWin = winnerId != null && sg.ids.includes(winnerId);
    let fill = i % 2 === 0 ? WHEEL.a : WHEEL.b;
    if (n % 2 === 1 && i === n - 1 && n > 1) fill = darkMode ? "#343434" : "#dcdcdc";
    if (sg.surprise) fill = darkMode ? "#2f3a34" : "#dfe9e3";
    if (isWin) fill = WHEEL.win;
    ctx.beginPath();
    ctx.moveTo(0, 0);
    ctx.arc(0, 0, r, a0, a0 + seg);
    ctx.closePath();
    ctx.fillStyle = fill;
    ctx.fill();
    ctx.strokeStyle = WHEEL.line;
    ctx.lineWidth = 2;
    ctx.stroke();

    ctx.save();
    const mid = a0 + seg / 2;
    const flip = Math.cos(mid) < 0;
    ctx.rotate(flip ? mid + Math.PI : mid);
    ctx.fillStyle = isWin ? WHEEL.winInk : WHEEL.ink;
    const fontSize = Math.round(Math.max(16, Math.min(32, 57 * seg + 4)));
    ctx.font = `500 ${fontSize}px 'Host Grotesk', sans-serif`;
    ctx.textAlign = flip ? "left" : "right";
    ctx.textBaseline = "middle";
    let label = sg.fresh ? "Neu: " + sg.label : sg.label;
    const maxW = r - 92;
    while (ctx.measureText(label).width > maxW && label.length > 3) label = label.slice(0, -2) + "…";
    ctx.fillText(label, flip ? -(r - 28) : r - 28, 1);
    ctx.restore();
  });

  ctx.beginPath();
  ctx.arc(0, 0, r, 0, Math.PI * 2);
  ctx.strokeStyle = WHEEL.line;
  ctx.lineWidth = 2;
  ctx.stroke();

  ctx.beginPath();
  ctx.arc(0, 0, 30, 0, Math.PI * 2);
  ctx.fillStyle = WHEEL.ink;
  ctx.fill();
  ctx.restore();
}

const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

// Während das Rad dreht, lassen sich Filter und Zusagen nicht ändern,
// sonst passt das gezeigte Rad nicht mehr zu dem, was gezogen wird.
function lockFilters(on) {
  document.querySelectorAll(".filters select, .filters button, .filters input, #join, #me-veg").forEach((el) => (el.disabled = on));
}

// Vor dem Drehen den Stand der anderen holen: wer dabei ist, wer vegetarisch isst,
// und ob inzwischen schon jemand gedreht hat.
async function refreshToday() {
  const today = todayBerlin();
  const [a, m, p, v, f] = await Promise.all([
    db.from("attendance").select("email").eq("day", today),
    db.from("members").select("*").order("email"),
    db.from("picks").select("*").eq("pick_date", today).order("created_at", { ascending: false }),
    db.from("vetoes").select("*").order("created_at", { ascending: false }).limit(300),
    db.from("favorites").select("email, restaurant_id"),
  ]);
  if (a.error || m.error || p.error || v.error || f.error) return;
  state.favorites = f.data;
  state.attendance = a.data.map((x) => x.email);
  state.attendanceWeek = state.attendanceWeek.filter((x) => x.day !== today).concat(a.data.map((x) => ({ day: today, email: x.email })));
  state.members = m.data;
  state.picks = p.data.concat(state.picks.filter((x) => x.pick_date !== today));
  state.vetoes = v.data;
  renderCrew();
  renderToday();
  renderWheel();
}

$("spin").addEventListener("click", async () => {
  if (state.spinning) return;
  state.spinning = true;
  $("spin").disabled = true;
  await refreshToday();
  const { list } = candidates();
  if (!list.length || validPickOn(todayBerlin())) {
    state.spinning = false;
    renderWheel();
    return;
  }
  lockFilters(true);

  // Feld nach Gewicht ziehen; im Überraschungsfeld dann einen der neuen Läden
  const { segs } = buildSegments(list);
  const total = segs.reduce((s, x) => s + x.weight, 0);
  let roll = Math.random() * total;
  let winner = 0;
  while (winner < segs.length - 1 && roll >= segs[winner].weight) roll -= segs[winner++].weight;
  const before = segs.slice(0, winner).reduce((s, x) => s + x.weight, 0);
  const segA = (Math.PI * 2 * segs[winner].weight) / total;
  const startA = (Math.PI * 2 * before) / total;
  const pointer = -Math.PI / 2; // Zeiger oben
  const target = pointer - (startA + segA * (0.15 + Math.random() * 0.7));
  const ids = segs[winner].ids;
  const rest = list.find((r) => r.id === ids[Math.floor(Math.random() * ids.length)]);
  const start = state.rotation;
  let delta = (target - start) % (Math.PI * 2);
  if (delta < 0) delta += Math.PI * 2;
  delta += Math.PI * 2 * (reduceMotion ? 0 : 5 + Math.floor(Math.random() * 3));
  const duration = reduceMotion ? 1 : 4800;
  const t0 = performance.now();

  function frame(now) {
    const t = Math.min(1, (now - t0) / duration);
    const ease = 1 - Math.pow(1 - t, 4);
    state.rotation = start + delta * ease;
    drawWheel(segs);
    if (t < 1) requestAnimationFrame(frame);
    else finish(rest, segs);
  }
  requestAnimationFrame(frame);
});

async function finish(rest, segs) {
  state.rotation %= Math.PI * 2;
  drawWheel(segs, rest.id);
  const { data, error } = await db.from("picks").insert({ restaurant_id: rest.id }).select().single();
  state.spinning = false;
  lockFilters(false);
  if (error) {
    $("verdict-kicker").textContent = "Die Ziehung ließ sich nicht speichern. Bitte noch mal drehen.";
    $("spin").disabled = false;
    return;
  }
  state.picks.unshift(data);
  renderToday(true);
  renderHistory();
}

function facts(r) {
  const parts = [];
  if (r.cuisine) parts.push(r.cuisine);
  if (r.price) parts.push({ 1: "günstig", 2: "mittel", 3: "eher teuer" }[r.price]);
  if (r.walk_minutes != null) parts.push(`${r.walk_minutes} Minuten zu Fuß`);
  if (r.vegetarian) parts.push("mit vegetarischer Auswahl");
  return parts.length ? parts.join(", ") + "." : "";
}

function renderToday(fresh = false) {
  const today = todayBerlin();
  $("verdict-date").textContent = new Date().toLocaleDateString("de-DE", { timeZone: "Europe/Berlin", weekday: "long", day: "numeric", month: "long" });
  const pick = validPickOn(today);
  const r = pick && state.restaurants.find((x) => x.id === pick.restaurant_id);
  const name = $("verdict-name");
  const box = $("verdict");
  renderVeto(pick);
  $("friday-hint").classList.toggle("hidden", weekdayBerlin() !== 5);
  $("rate-today").classList.add("hidden");
  if (!r) {
    box.classList.remove("decided");
    const lastVeto = state.picks.find((p) => p.pick_date === today && isVetoed(p));
    if (lastVeto) {
      const v = state.vetoes.find((x) => x.pick_id === lastVeto.id);
      const vr = state.restaurants.find((x) => x.id === lastVeto.restaurant_id);
      $("verdict-kicker").textContent = `${nameOf(v.email)} hat den Joker gegen ${vr?.name || "das Ergebnis"} gezogen`;
      name.textContent = "Neue Runde";
    } else {
      $("verdict-kicker").textContent = "Heute noch nicht gedreht";
      name.textContent = "Wohin geht's heute?";
    }
    $("verdict-facts").textContent = "";
    $("verdict-links").innerHTML = "";
    $("spin").textContent = "Rad drehen";
    $("spin").classList.remove("hidden");
    return;
  }
  const who = nameOf(pick.picked_by);
  box.classList.add("decided");
  $("verdict-kicker").textContent = `Heute geht's zu, gedreht von ${who}`;
  name.textContent = r.name;
  if (fresh && !reduceMotion) {
    name.classList.remove("reveal");
    void name.offsetWidth;
    name.classList.add("reveal");
  }
  $("verdict-facts").textContent = [facts(r), r.notes].filter(Boolean).join(" ");
  const links = [];
  if (r.address) links.push(`<a href="https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(r.name + " " + r.address)}" target="_blank" rel="noopener">Route in Google Maps</a>`);
  if (r.url) links.push(`<a href="${esc(r.url)}" target="_blank" rel="noopener">Speisekarte</a>`);
  $("verdict-links").innerHTML = links.join(" oder ");
  // Ist entschieden, wird nur noch per Joker neu gedreht
  $("spin").classList.add("hidden");
  // ab 13 Uhr nach dem Essen fragen
  const afterLunch = Number(new Intl.DateTimeFormat("en-GB", { timeZone: "Europe/Berlin", hour: "2-digit", hourCycle: "h23" }).format(new Date())) >= 13;
  $("rate-today").classList.toggle("hidden", !afterLunch);
  if (afterLunch) $("rate-today-btns").innerHTML = thumbsHtml(pick.id);
}

// ---------- Wetter-Modus (Open-Meteo, kostenlos, ohne Schlüssel) ----------

const OFFICE = { lat: 49.1427, lon: 9.2109 }; // Heilbronn
const RAIN_MAX_WALK = 7;

function rainBlocks() {
  return !!state.weather?.rainy && !$("rain-ok").checked;
}

async function loadWeather() {
  try {
    const url = `https://api.open-meteo.com/v1/forecast?latitude=${OFFICE.lat}&longitude=${OFFICE.lon}&hourly=temperature_2m,precipitation_probability,precipitation&timezone=Europe%2FBerlin&forecast_days=1`;
    const res = await fetch(url);
    if (!res.ok) return;
    const h = (await res.json()).hourly;
    // Mittagszeit: 12 und 13 Uhr
    const idx = h.time.map((t, i) => [t.slice(11, 13), i]).filter(([hh]) => hh === "12" || hh === "13").map(([, i]) => i);
    if (!idx.length) return;
    const prob = Math.max(...idx.map((i) => h.precipitation_probability[i] ?? 0));
    const mm = Math.max(...idx.map((i) => h.precipitation[i] ?? 0));
    const temp = Math.round(idx.reduce((s, i) => s + h.temperature_2m[i], 0) / idx.length);
    const rainy = prob >= 50 || mm >= 0.3;
    state.weather = {
      rainy,
      text: rainy
        ? `Heute Mittag ${temp} °C und Regen (${prob} %). Läden mit mehr als ${RAIN_MAX_WALK} Minuten Fußweg sind deshalb raus.`
        : `Heute Mittag ${temp} °C, eher trocken (Regenrisiko ${prob} %).`,
    };
    $("weather-text").textContent = state.weather.text;
    $("rain-ok-wrap").classList.toggle("hidden", !rainy);
    $("weather").classList.remove("hidden");
    renderWheel();
  } catch {
    // ohne Wetter geht es auch
  }
}

// ---------- Daumen hoch oder runter ----------

const THUMB = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7 10v10H4V10h3zm0 0l4-7c1.7 0 2.6 1.2 2.2 2.8L12.6 9H19a2 2 0 012 2.3l-1.2 7A2 2 0 0117.8 20H7"/></svg>';

function myThumb(pickId) {
  return state.ratings.find((x) => x.pick_id === pickId && x.email === state.email)?.thumbs || 0;
}

function thumbCounts(pickIds) {
  const set = new Set(pickIds);
  let up = 0, down = 0;
  for (const x of state.ratings) if (set.has(x.pick_id)) x.thumbs > 0 ? up++ : down++;
  return { up, down };
}

function thumbsHtml(pickId) {
  const mine = myThumb(pickId);
  const { up, down } = thumbCounts([pickId]);
  return `<span class="thumbs">
    <button class="btn btn--plain btn--small thumb" data-rate="${pickId}" data-v="1" aria-pressed="${mine === 1}" aria-label="Daumen hoch">${THUMB}<span>${up || ""}</span></button>
    <button class="btn btn--plain btn--small thumb down" data-rate="${pickId}" data-v="-1" aria-pressed="${mine === -1}" aria-label="Daumen runter">${THUMB}<span>${down || ""}</span></button>
  </span>`;
}

document.addEventListener("click", async (e) => {
  const b = e.target.closest("[data-rate]");
  if (!b) return;
  const pickId = Number(b.dataset.rate);
  const v = Number(b.dataset.v);
  const mine = myThumb(pickId);
  b.disabled = true;
  // gleicher Daumen noch mal = zurücknehmen
  const { error } = mine === v
    ? await db.from("ratings").delete().eq("pick_id", pickId).eq("email", state.email)
    : await db.from("ratings").upsert({ pick_id: pickId, thumbs: v, email: state.email });
  b.disabled = false;
  if (error) return alert("Hat nicht geklappt: " + error.message);
  state.ratings = state.ratings.filter((x) => !(x.pick_id === pickId && x.email === state.email));
  if (mine !== v) state.ratings.push({ pick_id: pickId, email: state.email, thumbs: v });
  renderToday();
  renderHistory();
});

$("to-week").addEventListener("click", (e) => {
  e.preventDefault();
  document.querySelector('.tab[data-tab="verlauf"]').click();
});

// ---------- Veto-Joker: einer pro Person und Woche ----------

function myJokerUsed() {
  return state.vetoes.some((v) => v.email === state.email && v.week_start === weekStartBerlin());
}

function renderVeto(pick) {
  const btn = $("veto");
  const info = $("veto-info");
  if (!pick) {
    btn.classList.add("hidden");
    info.textContent = "";
    return;
  }
  btn.classList.remove("hidden");
  const used = myJokerUsed();
  btn.disabled = used;
  btn.textContent = used ? "Joker schon eingesetzt" : "Joker einsetzen";
  info.textContent = used
    ? "Deinen Joker für diese Woche hast du schon gezogen. Ab Montag gibt es einen neuen."
    : "Passt dir das nicht? Mit deinem Joker lehnst du das Ergebnis einmal pro Woche ab, dann wird neu gedreht.";
}

$("veto").addEventListener("click", async () => {
  const pick = validPickOn(todayBerlin());
  if (!pick || myJokerUsed()) return;
  const r = state.restaurants.find((x) => x.id === pick.restaurant_id);
  if (!confirm(`Joker gegen ${r?.name || "dieses Ergebnis"} einsetzen? Du hast nur einen pro Woche.`)) return;
  $("veto").disabled = true;
  const { data, error } = await db.from("vetoes").insert({ pick_id: pick.id }).select().single();
  if (error) {
    $("veto-info").textContent = error.code === "23505" ? "Dein Joker für diese Woche ist schon weg." : "Hat nicht geklappt: " + error.message;
    $("veto").disabled = false;
    return;
  }
  state.vetoes.unshift(data);
  renderToday();
  renderWheel();
  renderHistory();
});

// ---------- Wer kommt mit ----------

function crewNeedsVeg() {
  return state.attendance.some((e) => state.members.find((m) => m.email === e)?.vegetarian);
}

function renderCrew() {
  const names = state.attendance.map(nameOf).sort((a, b) => a.localeCompare(b, "de"));
  const inCrew = state.attendance.includes(state.email);
  $("crew-line").textContent = names.length
    ? `Heute dabei (${names.length}): ${names.join(", ")}`
    : "Noch hat niemand zugesagt. Wer mitkommt, tippt auf „Bin dabei“.";
  $("join").textContent = inCrew ? "Bin dabei ✓" : "Bin dabei";
  $("join").setAttribute("aria-pressed", inCrew);
  $("me-veg").checked = !!state.members.find((m) => m.email === state.email)?.vegetarian;
}

$("join").addEventListener("click", async () => {
  const inCrew = state.attendance.includes(state.email);
  $("join").disabled = true;
  const { error } = inCrew
    ? await db.from("attendance").delete().eq("day", todayBerlin()).eq("email", state.email)
    : await db.from("attendance").insert({});
  $("join").disabled = false;
  if (error && error.code !== "23505") return alert("Hat nicht geklappt: " + error.message);
  state.attendance = inCrew ? state.attendance.filter((e) => e !== state.email) : [...state.attendance, state.email];
  const t = todayBerlin();
  state.attendanceWeek = state.attendanceWeek.filter((x) => !(x.day === t && x.email === state.email));
  if (!inCrew) state.attendanceWeek.push({ day: t, email: state.email });
  renderCrew();
  renderWheel();
});

$("me-veg").addEventListener("change", async (e) => {
  const v = e.target.checked;
  const { error } = await db.rpc("set_my_vegetarian", { v });
  if (error) {
    e.target.checked = !v;
    return alert("Hat nicht geklappt: " + error.message);
  }
  const me = state.members.find((m) => m.email === state.email);
  if (me) me.vegetarian = v;
  renderWheel();
});

$("quick-add").addEventListener("click", () => openForm(null));

// ---------- Restaurantliste ----------

$("search").addEventListener("input", renderList);

function renderList() {
  const q = $("search").value.trim().toLowerCase();
  const items = state.restaurants.filter((r) => !q || [r.name, r.cuisine, r.address, r.notes].join(" ").toLowerCase().includes(q));
  $("restaurant-list").innerHTML = items.length
    ? items
        .map(
          (r) => `
      <div class="item ${r.active ? "" : "inactive"}">
        <div class="main">
          <div class="title">${esc(r.name)}${r.vegetarian ? '<span class="tag">veggie</span>' : ""}${r.active ? "" : '<span class="tag">pausiert</span>'}</div>
          <div class="sub">${[r.cuisine, PRICE[r.price], r.walk_minutes != null ? r.walk_minutes + " Min." : null, r.address, closedText(r)].filter(Boolean).map(esc).join(" · ")}</div>
          ${r.notes ? `<div class="sub">${esc(r.notes)}</div>` : ""}
        </div>
        <div class="actions">
          <button class="btn btn--plain btn--small fav" data-fav="${r.id}" aria-pressed="${isMyFav(r.id)}" title="Lieblingsladen: bekommt ein größeres Feld im Rad">${HEART}<span>${favCount(r.id, true) || ""}</span><span class="sr-only">Favorit</span></button>
          <button class="btn btn--secondary btn--small" data-edit="${r.id}">Bearbeiten</button>
        </div>
      </div>`
        )
        .join("")
    : `<p class="muted">${state.restaurants.length ? "Nichts gefunden." : "Noch keine Restaurants. Trag das erste ein."}</p>`;
  document.querySelectorAll("[data-edit]").forEach((b) => b.addEventListener("click", () => openForm(b.dataset.edit)));
  document.querySelectorAll("[data-fav]").forEach((b) => b.addEventListener("click", () => toggleFav(b.dataset.fav)));
}

const HEART = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 20s-7-4.4-7-10a4 4 0 017-2.6A4 4 0 0119 10c0 5.6-7 10-7 10z"/></svg>';
const isMyFav = (id) => state.favorites.some((f) => f.email === state.email && f.restaurant_id === id);

async function toggleFav(id) {
  const mine = isMyFav(id);
  const { error } = mine
    ? await db.from("favorites").delete().eq("email", state.email).eq("restaurant_id", id)
    : await db.from("favorites").insert({ restaurant_id: id });
  if (error && error.code !== "23505") return alert("Hat nicht geklappt: " + error.message);
  state.favorites = mine
    ? state.favorites.filter((f) => !(f.email === state.email && f.restaurant_id === id))
    : [...state.favorites, { email: state.email, restaurant_id: id }];
  renderList();
  renderWheel();
}

const DAY_NAMES = { 1: "Mo", 2: "Di", 3: "Mi", 4: "Do", 5: "Fr", 6: "Sa", 7: "So" };
function closedText(r) {
  const d = (r.closed_days || []).slice().sort();
  return d.length ? "Ruhetag " + d.map((x) => DAY_NAMES[x]).join(", ") : null;
}

$("add-restaurant").addEventListener("click", () => openForm(null));
$("r-cancel").addEventListener("click", () => $("dlg").close());

function openForm(id) {
  const r = state.restaurants.find((x) => x.id === id) || {};
  $("dlg-title").textContent = id ? "Restaurant bearbeiten" : "Restaurant eintragen";
  $("r-id").value = id || "";
  $("r-name").value = r.name || "";
  $("r-cuisine").value = r.cuisine || "";
  $("r-price").value = r.price || "";
  $("r-walk").value = r.walk_minutes ?? "";
  $("r-veg").checked = !!r.vegetarian;
  $("r-address").value = r.address || "";
  $("r-url").value = r.url || "";
  $("r-notes").value = r.notes || "";
  $("r-active").checked = id ? r.active : true;
  document.querySelectorAll("[data-day]").forEach((cb) => (cb.checked = (r.closed_days || []).includes(Number(cb.dataset.day))));
  $("r-delete").classList.toggle("hidden", !(state.admin && id));
  setMsg($("r-msg"), id && r.created_by ? `Eingetragen von ${nameOf(r.created_by)}` : "");
  $("dlg").showModal();
}

$("r-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const id = $("r-id").value;
  const payload = {
    name: $("r-name").value.trim(),
    cuisine: $("r-cuisine").value.trim() || null,
    price: $("r-price").value ? Number($("r-price").value) : null,
    walk_minutes: $("r-walk").value === "" ? null : Number($("r-walk").value),
    vegetarian: $("r-veg").checked,
    address: $("r-address").value.trim() || null,
    url: $("r-url").value.trim() || null,
    notes: $("r-notes").value.trim() || null,
    active: $("r-active").checked,
    closed_days: [...document.querySelectorAll("[data-day]:checked")].map((cb) => Number(cb.dataset.day)),
  };
  const dup = state.restaurants.find((r) => r.id !== id && r.name.toLowerCase() === payload.name.toLowerCase());
  if (dup) return setMsg($("r-msg"), "Das Restaurant steht schon in der Liste.", "err");
  const res = id
    ? await db.from("restaurants").update(payload).eq("id", id).select().single()
    : await db.from("restaurants").insert(payload).select().single();
  if (res.error) return setMsg($("r-msg"), "Speichern fehlgeschlagen: " + res.error.message, "err");
  state.restaurants = state.restaurants.filter((r) => r.id !== res.data.id).concat(res.data).sort((a, b) => a.name.localeCompare(b.name, "de"));
  $("dlg").close();
  renderAll();
});

$("r-delete").addEventListener("click", async () => {
  const id = $("r-id").value;
  const r = state.restaurants.find((x) => x.id === id);
  if (!confirm(`„${r.name}" wirklich löschen? Die Ziehungen dazu verschwinden auch aus dem Verlauf. Wenn es nur vorübergehend nicht ins Rad soll, nimm lieber den Haken bei „kommt ins Glücksrad" raus.`)) return;
  const { error } = await db.from("restaurants").delete().eq("id", id);
  if (error) return setMsg($("r-msg"), "Löschen fehlgeschlagen: " + error.message, "err");
  state.restaurants = state.restaurants.filter((x) => x.id !== id);
  state.picks = state.picks.filter((p) => p.restaurant_id !== id);
  $("dlg").close();
  renderAll();
});

// ---------- Verlauf ----------

function renderHistory() {
  const byId = Object.fromEntries(state.restaurants.map((r) => [r.id, r]));
  // pro Tag nur die letzte Ziehung, die zählt
  const seen = new Set();
  const days = state.picks
    .filter((p) => !seen.has(p.pick_date) && seen.add(p.pick_date))
    .map((p) => validPickOn(p.pick_date))
    .filter(Boolean)
    .slice(0, 30);
  $("history").innerHTML = days.length
    ? days
        .map((p) => {
          const jokers = state.picks
            .filter((x) => x.pick_date === p.pick_date && isVetoed(x))
            .map((x) => `${nameOf(state.vetoes.find((v) => v.pick_id === x.id).email)} gegen ${byId[x.restaurant_id]?.name || "gelöscht"}`);
          return `<div class="item"><div class="main"><div class="title">${esc(byId[p.restaurant_id]?.name || "gelöscht")}</div>
          <div class="sub">${formatDate(p.pick_date)} · gedreht von ${esc(nameOf(p.picked_by))}${jokers.length ? ` · Joker: ${esc(jokers.join(", "))}` : ""}</div></div>
          <div class="actions">${thumbsHtml(p.id)}
          ${state.admin ? `<button class="btn btn--plain btn--small btn--destructive" data-undo="${p.id}">Entfernen</button>` : ""}</div></div>`;
        })
        .join("")
    : '<p class="muted">Noch nicht gedreht.</p>';
  document.querySelectorAll("[data-undo]").forEach((b) =>
    b.addEventListener("click", async () => {
      const { error } = await db.from("picks").delete().eq("id", b.dataset.undo);
      if (error) return alert(error.message);
      state.picks = state.picks.filter((p) => String(p.id) !== b.dataset.undo);
      renderToday();
      renderWheel();
      renderHistory();
    })
  );

  const counts = {};
  days.forEach((p) => (counts[p.restaurant_id] = (counts[p.restaurant_id] || 0) + 1));
  const top = Object.entries(counts).sort((a, b) => b[1] - a[1]).slice(0, 5);
  $("stats").innerHTML = top.length
    ? top.map(([id, n]) => `<div class="item"><div class="main">${esc(byId[id]?.name || "gelöscht")}</div><span class="count">${n}-mal</span></div>`).join("")
    : '<p class="muted">Noch keine Daten.</p>';

  renderRanking(byId);
  renderWeek(byId);
}

// Rangliste: alle gültigen Ziehungen eines Ladens, Daumen hoch minus runter
function renderRanking(byId) {
  const picksBy = {};
  state.picks.filter((p) => !isVetoed(p)).forEach((p) => (picksBy[p.restaurant_id] ||= []).push(p.id));
  const rows = Object.entries(picksBy)
    .map(([id, ids]) => ({ id, ...thumbCounts(ids) }))
    .filter((x) => x.up + x.down > 0)
    .sort((a, b) => b.up - b.down - (a.up - a.down) || b.up - a.up);
  $("ranking").innerHTML = rows.length
    ? rows
        .map(
          (x, i) => `<div class="item"><div class="main"><div class="title">${i + 1}. ${esc(byId[x.id]?.name || "gelöscht")}</div>
          <div class="sub">${x.up}-mal Daumen hoch, ${x.down}-mal runter</div></div><span class="count">${x.up - x.down > 0 ? "+" : ""}${x.up - x.down}</span></div>`
        )
        .join("")
    : '<p class="muted">Noch keine Bewertungen. Nach dem Essen auf Daumen hoch oder runter tippen.</p>';
}

// Wochenrückblick ab Montag. Kosten grob nach Preisstufe geschätzt.
const PRICE_EUR = { 1: 10, 2: 15, 3: 22 };
function renderWeek(byId) {
  const ws = weekStartBerlin();
  const seen = new Set();
  const days = state.picks
    .filter((p) => p.pick_date >= ws && !isVetoed(p) && !seen.has(p.pick_date) && seen.add(p.pick_date))
    .reverse();
  const box = $("week");
  if (!days.length) {
    box.innerHTML = "";
    box.classList.add("hidden");
    return;
  }
  box.classList.remove("hidden");
  const perHead = days.reduce((s, p) => s + (PRICE_EUR[byId[p.restaurant_id]?.price] || 0), 0);
  const unknown = days.filter((p) => !byId[p.restaurant_id]?.price).length;
  const heads = state.attendanceWeek.length;
  let best = null;
  for (const p of days) {
    const c = thumbCounts([p.id]);
    const score = c.up - c.down;
    if (c.up > 0 && (!best || score > best.score)) best = { p, score };
  }
  const friday = weekdayBerlin() >= 5;
  box.innerHTML = `
    <p class="label">${friday ? "Wochenrückblick" : "Diese Woche bisher"}</p>
    <h2>${best ? `Favorit der Woche: ${esc(byId[best.p.restaurant_id]?.name || "gelöscht")}` : `${days.length} ${days.length === 1 ? "Mittag" : "Mittage"} entschieden`}</h2>
    <div class="week-grid">
      <div><span class="num">${days.length}</span><span class="cap">${days.length === 1 ? "Tag" : "Tage"} essen gegangen</span></div>
      <div><span class="num">${perHead ? "ca. " + perHead + " €" : "–"}</span><span class="cap">pro Kopf ausgegeben</span></div>
      <div><span class="num">${heads || "–"}</span><span class="cap">Zusagen mit „Bin dabei“</span></div>
    </div>
    <ol>${days.map((p) => `<li>${formatDate(p.pick_date)}: ${esc(byId[p.restaurant_id]?.name || "gelöscht")}</li>`).join("")}</ol>
    <p class="small-note">Kosten geschätzt nach Preisstufe (€ 10 €, €€ 15 €, €€€ 22 €)${unknown ? `, ${unknown} ${unknown === 1 ? "Tag" : "Tage"} ohne Preisangabe` : ""}.</p>`;
}

// ---------- Kollegen (Admin) ----------

function renderMembers() {
  if (!state.admin) return;
  $("members").innerHTML = state.members
    .map(
      (m) => `<div class="item"><div class="main"><div class="title">${esc(m.display_name || m.email)}${m.is_admin ? '<span class="tag">Admin</span>' : ""}</div>
      <div class="sub">${esc(m.email)}</div></div>
      ${m.email !== state.email ? `<button class="btn btn--plain btn--small btn--destructive" data-remove="${esc(m.email)}">Entfernen</button>` : ""}</div>`
    )
    .join("");
  document.querySelectorAll("[data-remove]").forEach((b) =>
    b.addEventListener("click", async () => {
      if (!confirm(`${b.dataset.remove} den Zugang entziehen?`)) return;
      const { error } = await db.from("members").delete().eq("email", b.dataset.remove);
      if (error) return setMsg($("member-msg"), error.message, "err");
      state.members = state.members.filter((m) => m.email !== b.dataset.remove);
      renderMembers();
    })
  );
}

$("member-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const row = {
    email: $("m-email").value.trim().toLowerCase(),
    display_name: $("m-name").value.trim() || null,
    is_admin: $("m-admin").checked,
  };
  const { data, error } = await db.from("members").insert(row).select().single();
  if (error) {
    return setMsg($("member-msg"), error.code === "23505" ? "Die Adresse ist schon freigegeben." : error.message, "err");
  }
  state.members.push(data);
  state.members.sort((a, b) => a.email.localeCompare(b.email));
  e.target.reset();
  setMsg($("member-msg"), `${row.email} ist freigegeben. Schick den Link zur Seite weiter.`, "ok");
  renderMembers();
});

// ---------- Start ----------

db.auth.getSession().then(({ data }) => {
  if (data.session) start(data.session);
  else show("login");
});
