-- Schema des Supabase-Projekts "mittagessen-gluecksrad". Bereits angewendet; hier zur Dokumentation.

create table public.members (
  email text primary key check (email = lower(email)),
  display_name text,
  is_admin boolean not null default false,
  added_at timestamptz not null default now()
);

create table public.restaurants (
  id uuid primary key default gen_random_uuid(),
  name text not null check (length(trim(name)) > 0),
  cuisine text,
  price smallint check (price between 1 and 3),
  vegetarian boolean not null default false,
  walk_minutes smallint check (walk_minutes >= 0),
  address text,
  url text,
  notes text,
  active boolean not null default true,
  created_by text default lower(auth.jwt() ->> 'email'),
  created_at timestamptz not null default now()
);

create table public.picks (
  id bigint generated always as identity primary key,
  restaurant_id uuid not null references public.restaurants(id) on delete cascade,
  pick_date date not null default (now() at time zone 'Europe/Berlin')::date,
  picked_by text default lower(auth.jwt() ->> 'email'),
  created_at timestamptz not null default now()
);
create index picks_date_idx on public.picks (pick_date desc);

create or replace function public.is_member() returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.members where email = lower(auth.jwt() ->> 'email'));
$$;

create or replace function public.is_admin() returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.members where email = lower(auth.jwt() ->> 'email') and is_admin);
$$;

revoke execute on function public.is_member() from public, anon;
revoke execute on function public.is_admin() from public, anon;
grant execute on function public.is_member() to authenticated;
grant execute on function public.is_admin() to authenticated;

alter table public.members enable row level security;
alter table public.restaurants enable row level security;
alter table public.picks enable row level security;

create policy "Mitglieder lesen" on public.members for select to authenticated using ((select public.is_member()));
create policy "Admin legt an" on public.members for insert to authenticated with check ((select public.is_admin()));
create policy "Admin ändert" on public.members for update to authenticated using ((select public.is_admin()));
create policy "Admin entfernt" on public.members for delete to authenticated using ((select public.is_admin()) and email <> lower(auth.jwt() ->> 'email'));

create policy "Mitglieder lesen" on public.restaurants for select to authenticated using ((select public.is_member()));
create policy "Mitglieder legen an" on public.restaurants for insert to authenticated with check ((select public.is_member()));
create policy "Mitglieder ändern" on public.restaurants for update to authenticated using ((select public.is_member()));
create policy "Admin löscht" on public.restaurants for delete to authenticated using ((select public.is_admin()));

create policy "Mitglieder lesen" on public.picks for select to authenticated using ((select public.is_member()));
create policy "Mitglieder ziehen" on public.picks for insert to authenticated with check ((select public.is_member()));
create policy "Admin löscht" on public.picks for delete to authenticated using ((select public.is_admin()));

-- Nur freigegebene Adressen bekommen ein Konto
create or replace function public.nur_freigegebene() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if not exists (select 1 from public.members where email = lower(new.email)) then
    raise exception 'Diese E-Mail-Adresse ist nicht freigegeben';
  end if;
  return new;
end;
$$;
create trigger nur_freigegebene before insert on auth.users
  for each row execute function public.nur_freigegebene();
revoke execute on function public.nur_freigegebene() from public, anon, authenticated;

-- Erster Admin: insert into public.members (email, display_name, is_admin) values ('<adresse>', 'Christian', true);

-- ---------- Paket 1: Wer kommt mit, Veto-Joker, Ruhetage (2026-11-23) ----------
create or replace function public.berlin_today() returns date
  language sql stable set search_path = '' as $$ select (now() at time zone 'Europe/Berlin')::date $$;
create or replace function public.my_email() returns text
  language sql stable set search_path = '' as $$ select lower(auth.jwt() ->> 'email') $$;

alter table public.members add column if not exists vegetarian boolean not null default false;
alter table public.restaurants add column if not exists closed_days smallint[] not null default '{}'; -- ISO: 1 = Mo … 7 = So

-- eigene Vorliebe setzen, ohne Admin-Rechte am Rest der Zeile
create or replace function public.set_my_vegetarian(v boolean) returns void
  language sql security definer set search_path = '' as $$
  update public.members set vegetarian = v where email = public.my_email() $$;
revoke execute on function public.set_my_vegetarian(boolean) from public, anon;
grant execute on function public.set_my_vegetarian(boolean) to authenticated;

create table if not exists public.attendance (
  day date not null default public.berlin_today(),
  email text not null default public.my_email() references public.members(email) on delete cascade on update cascade,
  created_at timestamptz not null default now(),
  primary key (day, email)
);
alter table public.attendance enable row level security;
create policy "Mitglieder lesen" on public.attendance for select to authenticated using ((select public.is_member()));
create policy "Selbst zusagen" on public.attendance for insert to authenticated
  with check ((select public.is_member()) and email = (select public.my_email()) and day = (select public.berlin_today()));
create policy "Selbst absagen" on public.attendance for delete to authenticated
  using (email = (select public.my_email()));

-- ein Joker pro Person und Woche (unique email + week_start)
create table if not exists public.vetoes (
  id bigint generated always as identity primary key,
  pick_id bigint not null unique references public.picks(id) on delete cascade,
  email text not null default public.my_email() references public.members(email) on delete cascade on update cascade,
  week_start date not null default date_trunc('week', (now() at time zone 'Europe/Berlin'))::date,
  created_at timestamptz not null default now(),
  unique (email, week_start)
);
alter table public.vetoes enable row level security;
create policy "Mitglieder lesen" on public.vetoes for select to authenticated using ((select public.is_member()));
create policy "Joker einlösen" on public.vetoes for insert to authenticated
  with check (
    (select public.is_member()) and email = (select public.my_email())
    and week_start = date_trunc('week', (now() at time zone 'Europe/Berlin'))::date
    and exists (select 1 from public.picks p where p.id = pick_id and p.pick_date = (select public.berlin_today()))
  );
create policy "Admin löscht" on public.vetoes for delete to authenticated using ((select public.is_admin()));

grant select, insert, delete on public.attendance to authenticated;
grant select, insert, delete on public.vetoes to authenticated;
revoke all on public.attendance, public.vetoes from anon;

-- ---------- Paket 2: Favoriten für die Gewichtung (2026-11-23) ----------
create table if not exists public.favorites (
  email text not null default public.my_email() references public.members(email) on delete cascade on update cascade,
  restaurant_id uuid not null references public.restaurants(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (email, restaurant_id)
);
alter table public.favorites enable row level security;
create policy "Mitglieder lesen" on public.favorites for select to authenticated using ((select public.is_member()));
create policy "Selbst markieren" on public.favorites for insert to authenticated
  with check ((select public.is_member()) and email = (select public.my_email()));
create policy "Selbst entfernen" on public.favorites for delete to authenticated
  using (email = (select public.my_email()));
create index if not exists favorites_restaurant_idx on public.favorites(restaurant_id);
grant select, insert, delete on public.favorites to authenticated;
revoke all on public.favorites from anon;
