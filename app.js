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
  rotation: 0,
  spinning: false,
};

const COLORS = ["#e8590c", "#f59f00", "#2b8a3e", "#1971c2", "#9c36b5", "#c2255c", "#0c8599", "#5f3dc4", "#e67700", "#364fc7"];
const PRICE = { 1: "€", 2: "€€", 3: "€€€" };

function esc(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

function todayBerlin() {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Berlin" }).format(new Date());
}

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
    document.querySelector("#view-app").innerHTML = '<main class="login"><h1>Kein Zugang</h1><p class="muted">Deine Adresse ist nicht (mehr) freigegeben.</p><button class="btn ghost" onclick="db.auth.signOut().then(()=>location.reload())">Abmelden</button></main>';
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
  const [r, p, m] = await Promise.all([
    db.from("restaurants").select("*").order("name"),
    db.from("picks").select("*").order("created_at", { ascending: false }).limit(200),
    db.from("members").select("*").order("email"),
  ]);
  state.restaurants = r.data || [];
  state.picks = p.data || [];
  state.members = m.data || [];
}

function renderAll() {
  renderCuisineOptions();
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
    // pro Tag zählt nur die letzte Ziehung, also das, wo man wirklich war
    const last = state.picks.find((p) => p.pick_date === day);
    if (last) result.set(last.restaurant_id, day);
  }
  return result;
}

function candidates() {
  const exclude = recentlyEaten(Number($("f-exclude").value));
  const cuisine = $("f-cuisine").value;
  const maxPrice = Number($("f-price").value);
  const maxWalk = $("f-walk").value ? Number($("f-walk").value) : null;
  const veg = $("f-veg").value === "1";
  const list = state.restaurants.filter(
    (r) =>
      r.active &&
      !exclude.has(r.id) &&
      (!cuisine || r.cuisine === cuisine) &&
      (!r.price || r.price <= maxPrice) &&
      (maxWalk === null || r.walk_minutes == null || r.walk_minutes <= maxWalk) &&
      (!veg || r.vegetarian)
  );
  return { list, exclude };
}

["f-exclude", "f-cuisine", "f-price", "f-walk", "f-veg"].forEach((id) => $(id).addEventListener("change", renderWheel));

function renderCuisineOptions() {
  const cuisines = [...new Set(state.restaurants.map((r) => r.cuisine).filter(Boolean))].sort((a, b) => a.localeCompare(b, "de"));
  const sel = $("f-cuisine");
  const current = sel.value;
  sel.innerHTML = '<option value="">jede Küche</option>' + cuisines.map((c) => `<option value="${esc(c)}">nur ${esc(c)}</option>`).join("");
  sel.value = cuisines.includes(current) ? current : "";
  $("cuisine-list").innerHTML = cuisines.map((c) => `<option value="${esc(c)}">`).join("");
}

function renderWheel() {
  const { list, exclude } = candidates();
  drawWheel(list);
  const active = state.restaurants.filter((r) => r.active).length;
  const names = [...exclude.keys()].map((id) => state.restaurants.find((x) => x.id === id)?.name).filter(Boolean);
  let info = `${list.length} von ${active} Restaurants sind im Rad.`;
  if (names.length) info += ` Draußen: ${names.join(", ")}.`;
  $("f-info").textContent = info;
  $("spin").disabled = list.length === 0 || state.spinning;
}

// Farben des Rads: Trollingerrot und Weiß im Wechsel, wie ein Jahrmarktrad.
const darkMode = window.matchMedia("(prefers-color-scheme: dark)").matches;
const WHEEL = { red: "#8c1c2c", white: "#fbfaf8", dark: "#231d1b", rim: darkMode ? "#3d322d" : "#231d1b", bulbOn: "#ffd66b", bulbOff: "#5a4a3c" };
const BULBS = 28;

function drawWheel(list, bulbPhase = -1) {
  const c = $("wheel");
  const ctx = c.getContext("2d");
  const size = c.width;
  const R = size / 2;
  const rimW = 34;
  const r = R - rimW;
  ctx.clearRect(0, 0, size, size);
  ctx.save();
  ctx.translate(R, R);

  // Rand mit Glühbirnen
  ctx.beginPath();
  ctx.arc(0, 0, R - 2, 0, Math.PI * 2);
  ctx.fillStyle = WHEEL.rim;
  ctx.fill();
  for (let i = 0; i < BULBS; i++) {
    const a = (i / BULBS) * Math.PI * 2 - Math.PI / 2;
    const lit = bulbPhase < 0 ? true : (i + bulbPhase) % 3 === 0;
    ctx.beginPath();
    ctx.arc(Math.cos(a) * (R - rimW / 2 - 1), Math.sin(a) * (R - rimW / 2 - 1), 7, 0, Math.PI * 2);
    ctx.fillStyle = lit ? WHEEL.bulbOn : WHEEL.bulbOff;
    ctx.fill();
  }

  if (list.length === 0) {
    ctx.beginPath();
    ctx.arc(0, 0, r, 0, Math.PI * 2);
    ctx.fillStyle = WHEEL.white;
    ctx.fill();
    ctx.fillStyle = WHEEL.dark;
    ctx.font = "600 30px 'Barlow Semi Condensed', sans-serif";
    ctx.textAlign = "center";
    ctx.fillText(state.restaurants.length ? "Nichts passt zu den Filtern" : "Noch keine Restaurants", 0, 10);
    ctx.restore();
    return;
  }

  const n = list.length;
  const seg = (Math.PI * 2) / n;
  list.forEach((rest, i) => {
    const a0 = state.rotation + i * seg;
    // bei ungerader Anzahl wäre die Naht rot an rot, deshalb das letzte Feld dunkel
    let fill = i % 2 === 0 ? WHEEL.red : WHEEL.white;
    if (n % 2 === 1 && i === n - 1 && n > 1) fill = WHEEL.dark;
    const text = fill === WHEEL.white ? WHEEL.red : WHEEL.white;
    ctx.beginPath();
    ctx.moveTo(0, 0);
    ctx.arc(0, 0, r, a0, a0 + seg);
    ctx.closePath();
    ctx.fillStyle = fill;
    ctx.fill();

    ctx.save();
    ctx.rotate(a0 + seg / 2);
    ctx.fillStyle = text;
    const fontSize = Math.round(Math.max(18, Math.min(38, 420 / n + 6)));
    ctx.font = `700 ${fontSize}px 'Barlow Semi Condensed', sans-serif`;
    ctx.textAlign = "right";
    ctx.textBaseline = "middle";
    let label = rest.name;
    const maxW = r - 70;
    while (ctx.measureText(label).width > maxW && label.length > 3) label = label.slice(0, -2) + "…";
    ctx.fillText(label, r - 22, 1);
    ctx.restore();
  });

  // Speichen als feine Linien
  ctx.strokeStyle = "rgba(35,29,27,.35)";
  ctx.lineWidth = 1.5;
  for (let i = 0; i < n && n > 1; i++) {
    const a = state.rotation + i * seg;
    ctx.beginPath();
    ctx.moveTo(0, 0);
    ctx.lineTo(Math.cos(a) * r, Math.sin(a) * r);
    ctx.stroke();
  }

  // Nabe
  ctx.beginPath();
  ctx.arc(0, 0, 40, 0, Math.PI * 2);
  ctx.fillStyle = WHEEL.rim;
  ctx.fill();
  ctx.beginPath();
  ctx.arc(0, 0, 10, 0, Math.PI * 2);
  ctx.fillStyle = WHEEL.bulbOn;
  ctx.fill();
  ctx.restore();
}

const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

$("spin").addEventListener("click", () => {
  const { list } = candidates();
  if (!list.length || state.spinning) return;
  state.spinning = true;
  $("spin").disabled = true;
  $("tab-rad").classList.add("is-spinning");

  const winner = Math.floor(Math.random() * list.length);
  const seg = (Math.PI * 2) / list.length;
  const pointer = -Math.PI / 2; // Klapper oben
  const jitter = (Math.random() - 0.5) * seg * 0.7;
  const target = pointer - (winner + 0.5) * seg + jitter;
  const start = state.rotation;
  let delta = (target - start) % (Math.PI * 2);
  if (delta < 0) delta += Math.PI * 2;
  delta += Math.PI * 2 * (reduceMotion ? 0 : 5 + Math.floor(Math.random() * 3));
  const duration = reduceMotion ? 1 : 5200;
  const t0 = performance.now();

  function frame(now) {
    const t = Math.min(1, (now - t0) / duration);
    const ease = 1 - Math.pow(1 - t, 4);
    state.rotation = start + delta * ease;
    drawWheel(list, t < 1 ? Math.floor(now / 90) % 3 : -1);
    if (t < 1) requestAnimationFrame(frame);
    else finish(list[winner]);
  }
  requestAnimationFrame(frame);
});

async function finish(rest) {
  state.rotation %= Math.PI * 2;
  const { data, error } = await db.from("picks").insert({ restaurant_id: rest.id }).select().single();
  state.spinning = false;
  $("tab-rad").classList.remove("is-spinning");
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
  if (r.vegetarian) parts.push("mit Veggie-Auswahl");
  return parts.length ? parts.join(", ") + "." : "";
}

function renderToday(fresh = false) {
  const today = todayBerlin();
  const pick = state.picks.find((p) => p.pick_date === today);
  const r = pick && state.restaurants.find((x) => x.id === pick.restaurant_id);
  const name = $("verdict-name");
  if (!r) {
    $("verdict-kicker").textContent = "Heute noch nicht gedreht.";
    name.textContent = "Wohin geht's?";
    name.classList.remove("decided");
    $("verdict-facts").textContent = "";
    $("verdict-links").innerHTML = "";
    $("spin").textContent = "Rad drehen";
    return;
  }
  const count = state.picks.filter((p) => p.pick_date === today).length;
  const who = nameOf(pick.picked_by);
  $("verdict-kicker").textContent = count > 1 ? `Heute geht's zu (${count}. Dreh, von ${who})` : `Heute geht's zu (gedreht von ${who})`;
  name.textContent = r.name;
  name.classList.add("decided");
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
  $("spin").textContent = "Noch mal drehen";
}

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
          <div class="sub">${[r.cuisine, PRICE[r.price], r.walk_minutes != null ? r.walk_minutes + " Min." : null, r.address].filter(Boolean).map(esc).join(" · ")}</div>
          ${r.notes ? `<div class="sub">${esc(r.notes)}</div>` : ""}
        </div>
        <button class="btn ghost small" data-edit="${r.id}">Bearbeiten</button>
      </div>`
        )
        .join("")
    : `<p class="muted">${state.restaurants.length ? "Nichts gefunden." : "Noch keine Restaurants. Trag das erste ein."}</p>`;
  document.querySelectorAll("[data-edit]").forEach((b) => b.addEventListener("click", () => openForm(b.dataset.edit)));
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
  const days = state.picks.filter((p) => !seen.has(p.pick_date) && seen.add(p.pick_date)).slice(0, 30);
  $("history").innerHTML = days.length
    ? days
        .map((p) => {
          const tries = state.picks.filter((x) => x.pick_date === p.pick_date).length;
          return `<div class="item"><div class="main"><div class="title">${esc(byId[p.restaurant_id]?.name || "gelöscht")}</div>
          <div class="sub">${formatDate(p.pick_date)} · gedreht von ${esc(nameOf(p.picked_by))}${tries > 1 ? ` · ${tries} Versuche` : ""}</div></div>
          ${state.admin ? `<button class="btn ghost small" data-undo="${p.id}">Entfernen</button>` : ""}</div>`;
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
    ? top.map(([id, n]) => `<div class="item"><div class="main">${esc(byId[id]?.name || "gelöscht")}</div><strong>${n}×</strong></div>`).join("")
    : '<p class="muted">Noch keine Daten.</p>';
}

// ---------- Kollegen (Admin) ----------

function renderMembers() {
  if (!state.admin) return;
  $("members").innerHTML = state.members
    .map(
      (m) => `<div class="item"><div class="main"><div class="title">${esc(m.display_name || m.email)}${m.is_admin ? '<span class="tag">Admin</span>' : ""}</div>
      <div class="sub">${esc(m.email)}</div></div>
      ${m.email !== state.email ? `<button class="btn ghost small" data-remove="${esc(m.email)}">Entfernen</button>` : ""}</div>`
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
