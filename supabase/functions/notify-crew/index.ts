// Schickt allen, die heute "Bin dabei" getippt haben, eine Mail mit Ziel, Uhrzeit und Treffpunkt.
// Versand über Gmail. Die Zugangsdaten stehen nur als Geheimnisse in Supabase:
//   GMAIL_USER          die Gmail-Adresse
//   GMAIL_APP_PASSWORD  das 16-stellige App-Passwort
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2.45.4";
import nodemailer from "npm:nodemailer@6.9.14";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { ...CORS, "Content-Type": "application/json" } });

const todayBerlin = () => new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Berlin" }).format(new Date());

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return json(405, { error: "Nur POST" });

  const user = Deno.env.get("GMAIL_USER");
  const pass = Deno.env.get("GMAIL_APP_PASSWORD");
  if (!user || !pass) return json(500, { error: "Mailversand ist noch nicht eingerichtet (GMAIL_USER und GMAIL_APP_PASSWORD fehlen)." });

  // Alles mit den Rechten der Person lesen, die den Knopf drückt: RLS entscheidet.
  // öffentlicher Schlüssel, steht auch in app.js
  const key = Deno.env.get("SUPABASE_ANON_KEY") ?? "sb_publishable_E40kXVHnlZNEwjYLgtzqcQ_9-JUNxyL";
  const db = createClient(Deno.env.get("SUPABASE_URL")!, key, {
    global: { headers: { Authorization: req.headers.get("Authorization") ?? "" } },
  });
  const { data: auth } = await db.auth.getUser();
  const me = auth.user?.email?.toLowerCase();
  if (!me) return json(401, { error: "Nicht angemeldet" });

  const day = todayBerlin();
  const [members, meetup, picks, vetoes, attendance] = await Promise.all([
    db.from("members").select("email, display_name"),
    db.from("meetups").select("*").eq("day", day).maybeSingle(),
    db.from("picks").select("id, restaurant_id").eq("pick_date", day).order("created_at", { ascending: false }),
    db.from("vetoes").select("pick_id"),
    db.from("attendance").select("email").eq("day", day),
  ]);
  const names = new Map((members.data ?? []).map((m) => [m.email, m.display_name || m.email.split("@")[0]]));
  if (!names.has(me)) return json(403, { error: "Nicht freigegeben" });

  // Es zählt nur der neueste Pick des Tages. Wurde er per Veto gekippt, ist der Tag offen (wie validPickOn in app.js).
  const vetoed = new Set((vetoes.data ?? []).map((v) => v.pick_id));
  const pick = (picks.data ?? [])[0];
  if (!pick) return json(400, { error: "Heute wurde noch nicht gedreht." });
  if (vetoed.has(pick.id)) return json(400, { error: "Das heutige Ergebnis wurde per Veto gekippt. Erst neu drehen." });
  const { data: rest } = await db.from("restaurants").select("name, address, menu_url").eq("id", pick.restaurant_id).single();

  const to = (attendance.data ?? []).map((a) => a.email);
  if (!to.length) return json(400, { error: "Noch hat niemand „Bin dabei“ getippt." });

  // Sendeplatz in der Datenbank belegen, bevor die Mail rausgeht. So kann bei zwei
  // gleichzeitigen Klicks nur einer gewinnen (die Zeile wird beim UPDATE gesperrt).
  if (!meetup.data) await db.from("meetups").upsert({ day }, { onConflict: "day", ignoreDuplicates: true });
  const before = meetup.data?.notified_at ?? null;
  const claimedAt = new Date().toISOString();
  const cutoff = new Date(Date.now() - 10 * 60 * 1000).toISOString();
  const { data: claimed, error: claimError } = await db
    .from("meetups")
    .update({ notified_at: claimedAt })
    .eq("day", day)
    .or(`notified_at.is.null,notified_at.lt.${cutoff}`)
    .select()
    .maybeSingle();
  if (claimError) return json(500, { error: "Treffpunkt konnte nicht gelesen werden: " + claimError.message });
  if (!claimed) return json(429, { error: "Die Mail ging gerade erst raus. Bitte frühestens in 10 Minuten noch mal." });
  const m = claimed;

  const lines = m.ordering
    ? [`Heute wird bei ${rest?.name} bestellt.`, `Bestellt wird um ${m.meet_time} Uhr. Tragt bis dahin auf der Seite ein, was ihr möchtet.`]
    : [`Heute geht's zu ${rest?.name}${rest?.address ? ` (${rest.address})` : ""}.`, `Treffpunkt: ${m.meet_time} Uhr, ${m.place}.`];
  if (rest?.menu_url) lines.push(`Tageskarte: ${rest.menu_url}`);
  lines.push("", `Dabei: ${to.map((e) => names.get(e) ?? e).join(", ")}`, "", `Geschickt von ${names.get(me)} über https://mittagsrad.vercel.app`);

  const transport = nodemailer.createTransport({ host: "smtp.gmail.com", port: 465, secure: true, auth: { user, pass } });
  try {
    await transport.sendMail({
      from: `Mittagsrad <${user}>`,
      to: user,
      bcc: to,
      replyTo: me,
      subject: m.ordering ? `Mittagessen: Bestellung bei ${rest?.name} um ${m.meet_time}` : `Mittagessen: ${rest?.name} um ${m.meet_time}`,
      text: lines.join("\n"),
    });
  } catch (e) {
    // Sendeplatz wieder freigeben, damit man es gleich noch mal versuchen kann.
    await db.from("meetups").update({ notified_at: before }).eq("day", day).eq("notified_at", claimedAt);
    return json(502, { error: "Mail konnte nicht verschickt werden: " + (e as Error).message });
  }

  return json(200, { sent: to.length, meetup: m });
});
