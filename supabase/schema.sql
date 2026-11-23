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
