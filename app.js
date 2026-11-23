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
// Die Ziehung, die für einen Tag gilt: die letzte, gegen die kein Joker eingesetzt wurde
const validPickOn = (day) => state.picks.find((p) => p.pick_date === day && !isVetoed(p));

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
}

// ---------- Daten ----------

async function loadAll() {
  const [r, p, m, a, v] = await Promise.all([
    db.from("restaurants").select("*").order("name"),
    db.from("picks").select("*").order("created_at", { ascending: false }).limit(300),
    db.from("members").select("*").order("email"),
    db.from("attendance").select("email").eq("day", todayBerlin()),
    db.from("vetoes").select("*").order("created_at", { ascending: false }).limit(300),
  ]);
  state.restaurants = r.data || [];
  state.picks = p.data || [];
  state.members = m.data || [];
  state.attendance = (a.data || []).map((x) => x.email);
  state.vetoes = v.data || [];
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
      (!cuisine || r.cuisine === cuisine) &&
      (!r.price || r.price <= maxPrice) &&
      (maxWalk === null || r.walk_minutes == null || r.walk_minutes <= maxWalk) &&
      (!veg || r.vegetarian)
  );
  return { list, exclude, closed, vetoed, crewVeg };
}

["f-exclude", "f-cuisine", "f-price", "f-walk", "f-veg"].forEach((id) => $(id).addEventListener("change", renderWheel));
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
  drawWheel(list, todays?.restaurant_id);
  const active = state.restaurants.filter((r) => r.active).length;
  const nameList = (ids) => ids.map((id) => state.restaurants.find((x) => x.id === id)?.name).filter(Boolean).join(", ");
  let info = `${list.length} von ${active} Restaurants im Rad.`;
  if (exclude.size) info += ` Nicht dabei, weil es das zuletzt gab: ${nameList([...exclude.keys()])}.`;
  if (closed.length) info += ` Heute Ruhetag: ${closed.map((r) => r.name).join(", ")}.`;
  if (vetoed.size) info += ` Heute per Joker abgelehnt: ${nameList([...vetoed])}.`;
  if (crewVeg) info += " Jemand von euch isst vegetarisch, deshalb nur Läden mit vegetarischer Auswahl.";
  $("f-info").textContent = info;
  $("spin").disabled = list.length === 0 || state.spinning;
}

// Rad in den Farben der Seite: Weiß und Hellgrau im Wechsel, Mint nur für das Gewinnerfeld.
const darkMode = window.matchMedia("(prefers-color-scheme: dark)").matches;
const WHEEL = darkMode
  ? { a: "#1f1f1f", b: "#2a2a2a", ink: "#f1f1f1", line: "rgba(241,241,241,.16)", win: "#145a3d", winInk: "#ffffff" }
  : { a: "#ffffff", b: "#e9e9e9", ink: "#232323", line: "rgba(35,35,35,.16)", win: "#0b3d2a", winInk: "#ffffff" };

function drawWheel(list, winnerId = null) {
  const c = $("wheel");
  const ctx = c.getContext("2d");
  const size = c.width;
  const R = size / 2;
  const r = R - 4;
  ctx.clearRect(0, 0, size, size);
  ctx.save();
  ctx.translate(R, R);

  if (list.length === 0) {
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

  const n = list.length;
  const seg = (Math.PI * 2) / n;
  list.forEach((rest, i) => {
    const a0 = state.rotation + i * seg;
    const isWin = rest.id === winnerId;
    let fill = i % 2 === 0 ? WHEEL.a : WHEEL.b;
    if (n % 2 === 1 && i === n - 1 && n > 1) fill = darkMode ? "#343434" : "#dcdcdc";
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
    const fontSize = Math.round(Math.max(18, Math.min(32, 360 / n + 4)));
    ctx.font = `500 ${fontSize}px 'Host Grotesk', sans-serif`;
    ctx.textAlign = flip ? "left" : "right";
    ctx.textBaseline = "middle";
    let label = rest.name;
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

$("spin").addEventListener("click", () => {
  const { list } = candidates();
  if (!list.length || state.spinning) return;
  state.spinning = true;
  $("spin").disabled = true;
  lockFilters(true);

  const winner = Math.floor(Math.random() * list.length);
  const seg = (Math.PI * 2) / list.length;
  const pointer = -Math.PI / 2; // Zeiger oben
  const jitter = (Math.random() - 0.5) * seg * 0.7;
  const target = pointer - (winner + 0.5) * seg + jitter;
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
    drawWheel(list);
    if (t < 1) requestAnimationFrame(frame);
    else finish(list[winner], list);
  }
  requestAnimationFrame(frame);
});

async function finish(rest, list) {
  state.rotation %= Math.PI * 2;
  drawWheel(list, rest.id);
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
  renderWheel();
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
}

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
        <button class="btn btn--secondary btn--small" data-edit="${r.id}">Bearbeiten</button>
      </div>`
        )
        .join("")
    : `<p class="muted">${state.restaurants.length ? "Nichts gefunden." : "Noch keine Restaurants. Trag das erste ein."}</p>`;
  document.querySelectorAll("[data-edit]").forEach((b) => b.addEventListener("click", () => openForm(b.dataset.edit)));
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
  const days = state.picks.filter((p) => !isVetoed(p) && !seen.has(p.pick_date) && seen.add(p.pick_date)).slice(0, 30);
  $("history").innerHTML = days.length
    ? days
        .map((p) => {
          const jokers = state.picks
            .filter((x) => x.pick_date === p.pick_date && isVetoed(x))
            .map((x) => `${nameOf(state.vetoes.find((v) => v.pick_id === x.id).email)} gegen ${byId[x.restaurant_id]?.name || "gelöscht"}`);
          return `<div class="item"><div class="main"><div class="title">${esc(byId[p.restaurant_id]?.name || "gelöscht")}</div>
          <div class="sub">${formatDate(p.pick_date)} · gedreht von ${esc(nameOf(p.picked_by))}${jokers.length ? ` · Joker: ${esc(jokers.join(", "))}` : ""}</div></div>
          ${state.admin ? `<button class="btn btn--plain btn--small btn--destructive" data-undo="${p.id}">Entfernen</button>` : ""}</div>`;
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
