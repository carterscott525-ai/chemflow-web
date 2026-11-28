-- ChemFlow Web — Phase 1 schema (Supabase / Postgres)
-- Multi-tenant: every tenant row carries business_id; RLS enforces isolation
-- via my_business_id() / my_role() derived from the signed-in user's profile.

create or replace function public.my_business_id()
returns uuid language sql stable security definer set search_path = public
as $$ select business_id from public.profiles where id = auth.uid() $$;

create or replace function public.my_role()
returns text language sql stable security definer set search_path = public
as $$ select role from public.profiles where id = auth.uid() $$;

-- ============ tables ============

create table public.businesses (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  owner_email text,
  settings jsonb not null default '{}'::jsonb,
  device_endpoint text,
  created_at timestamptz not null default now()
);

create table public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  business_id uuid not null references public.businesses(id) on delete cascade,
  role text not null check (role in ('owner','tech')),
  name text,
  email text,
  created_at timestamptz not null default now()
);

create table public.invites (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references public.businesses(id) on delete cascade,
  email text not null,
  role text not null default 'tech' check (role in ('owner','tech')),
  created_at timestamptz not null default now(),
  unique (business_id, email)
);

create table public.customers (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references public.businesses(id) on delete cascade,
  name text not null,
  address text,
  phone text,
  email text,
  service_day text,
  technician_id uuid references public.profiles(id) on delete set null,
  ph_min numeric not null default 7.2,
  ph_max numeric not null default 7.8,
  orp_min numeric not null default 800,
  orp_max numeric not null default 850,
  active boolean not null default true,
  created_at timestamptz not null default now()
);

create table public.bodies_of_water (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references public.businesses(id) on delete cascade,
  customer_id uuid not null references public.customers(id) on delete cascade,
  name text not null default 'Main Pool',
  created_at timestamptz not null default now()
);

create table public.checklist_templates (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references public.businesses(id) on delete cascade,
  name text not null default 'Standard Visit',
  steps jsonb not null default '[]'::jsonb,
  created_at timestamptz not null default now()
);

create table public.visits (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references public.businesses(id) on delete cascade,
  customer_id uuid not null references public.customers(id) on delete cascade,
  body_id uuid references public.bodies_of_water(id) on delete set null,
  tech_id uuid references public.profiles(id) on delete set null,
  started_at timestamptz not null,
  finished_at timestamptz,
  duration_sec integer,
  label text not null default 'Web Check-In',
  fc numeric, tc numeric, ph numeric, ta numeric, th numeric,
  stabilizer numeric, orp numeric, tds numeric, temp numeric,
  notes text,
  checkin_lat numeric, checkin_lng numeric,
  checkout_lat numeric, checkout_lng numeric,
  created_at timestamptz not null default now()
);

create table public.visit_checklist (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references public.businesses(id) on delete cascade,
  visit_id uuid not null references public.visits(id) on delete cascade,
  step_label text not null,
  done boolean not null default false
);

create table public.visit_photos (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references public.businesses(id) on delete cascade,
  visit_id uuid not null references public.visits(id) on delete cascade,
  storage_path text not null
);

-- ============ row level security ============

alter table public.businesses enable row level security;
alter table public.profiles enable row level security;
alter table public.invites enable row level security;
alter table public.customers enable row level security;
alter table public.bodies_of_water enable row level security;
alter table public.checklist_templates enable row level security;
alter table public.visits enable row level security;
alter table public.visit_checklist enable row level security;
alter table public.visit_photos enable row level security;

-- businesses: any signed-in user can create one; members can read; owner can update
create policy biz_insert on public.businesses for insert to authenticated with check (true);
create policy biz_select on public.businesses for select to authenticated using (id = public.my_business_id());
create policy biz_update on public.businesses for update to authenticated
  using (id = public.my_business_id() and public.my_role() = 'owner')
  with check (id = public.my_business_id() and public.my_role() = 'owner');

-- profiles: create your own; read own + same-business; update own
create policy prof_insert on public.profiles for insert to authenticated with check (id = auth.uid());
create policy prof_select on public.profiles for select to authenticated
  using (id = auth.uid() or business_id = public.my_business_id());
create policy prof_update on public.profiles for update to authenticated using (id = auth.uid()) with check (id = auth.uid());

-- invites: owner manages own business's invites; invitee can read invites for their email
create policy inv_owner on public.invites for all to authenticated
  using (business_id = public.my_business_id() and public.my_role() = 'owner')
  with check (business_id = public.my_business_id() and public.my_role() = 'owner');
create policy inv_read on public.invites for select to authenticated using (email = auth.email());
create policy inv_delete_self on public.invites for delete to authenticated using (email = auth.email());

-- customers: members read; owner writes
create policy cust_select on public.customers for select to authenticated using (business_id = public.my_business_id());
create policy cust_write on public.customers for insert to authenticated
  with check (business_id = public.my_business_id() and public.my_role() = 'owner');
create policy cust_update on public.customers for update to authenticated
  using (business_id = public.my_business_id() and public.my_role() = 'owner')
  with check (business_id = public.my_business_id() and public.my_role() = 'owner');
create policy cust_delete on public.customers for delete to authenticated
  using (business_id = public.my_business_id() and public.my_role() = 'owner');

-- bodies of water: members read; owner writes
create policy bow_select on public.bodies_of_water for select to authenticated using (business_id = public.my_business_id());
create policy bow_write on public.bodies_of_water for all to authenticated
  using (business_id = public.my_business_id() and public.my_role() = 'owner')
  with check (business_id = public.my_business_id() and public.my_role() = 'owner');

-- checklist templates: members read; owner writes
create policy tpl_select on public.checklist_templates for select to authenticated using (business_id = public.my_business_id());
create policy tpl_write on public.checklist_templates for all to authenticated
  using (business_id = public.my_business_id() and public.my_role() = 'owner')
  with check (business_id = public.my_business_id() and public.my_role() = 'owner');

-- visits: members of the business can read visits in their business
-- (owner sees all; techs see all in-business for route context in Phase 1)
create policy vis_select on public.visits for select to authenticated using (business_id = public.my_business_id());
create policy vis_insert on public.visits for insert to authenticated
  with check (business_id = public.my_business_id() and tech_id = auth.uid());
create policy vis_update on public.visits for update to authenticated
  using (business_id = public.my_business_id() and (tech_id = auth.uid() or public.my_role() = 'owner'))
  with check (business_id = public.my_business_id());

-- visit checklist + photos: same business, tied to a visit
create policy vc_all on public.visit_checklist for all to authenticated
  using (business_id = public.my_business_id()) with check (business_id = public.my_business_id());
create policy vp_all on public.visit_photos for all to authenticated
  using (business_id = public.my_business_id()) with check (business_id = public.my_business_id());

-- ============ storage: visit photos ============

insert into storage.buckets (id, name, public) values ('visit-photos', 'visit-photos', false);

create policy photos_select on storage.objects for select to authenticated
  using (bucket_id = 'visit-photos' and (storage.foldername(name))[1] = public.my_business_id()::text);
create policy photos_insert on storage.objects for insert to authenticated
  with check (bucket_id = 'visit-photos' and (storage.foldername(name))[1] = public.my_business_id()::text);
create policy photos_update on storage.objects for update to authenticated
  using (bucket_id = 'visit-photos' and (storage.foldername(name))[1] = public.my_business_id()::text);
create policy photos_delete on storage.objects for delete to authenticated
  using (bucket_id = 'visit-photos' and (storage.foldername(name))[1] = public.my_business_id()::text);

-- ============ table privileges for the API roles ============
-- Required when tables are created via SQL: unlike the Table Editor, raw DDL
-- does not auto-grant privileges to the anon/authenticated roles, and every
-- API call then fails with "permission denied for table ..." even though the
-- RLS policies above are correct. (Found by the 2026-11-26 end-to-end test.)
-- The RLS policies remain the actual access control — anon has no policies,
-- so these grants alone expose nothing.
grant select, insert, update, delete on all tables in schema public to authenticated;
grant select, insert, update, delete on all tables in schema public to anon;

-- ============ one-tap check-in (added 2026-11-26, Carter's rule) ============
-- Visits record where the tech was when they tapped Check In / Check Out,
-- when the phone provides GPS. No-op on a fresh install (columns already in
-- the CREATE TABLE above); needed on the live project created earlier.
alter table public.visits add column if not exists checkin_lat numeric;
alter table public.visits add column if not exists checkin_lng numeric;
alter table public.visits add column if not exists checkout_lat numeric;
alter table public.visits add column if not exists checkout_lng numeric;

-- ============ Phase 2: business ops (quotes, jobs, invoices, equipment) ============

create table if not exists public.quotes (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references public.businesses(id) on delete cascade,
  customer_id uuid not null references public.customers(id) on delete cascade,
  title text not null,
  details text,
  amount numeric not null default 0,
  status text not null default 'draft' check (status in ('draft','sent','approved','declined')),
  created_at timestamptz not null default now()
);

create table if not exists public.jobs (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references public.businesses(id) on delete cascade,
  customer_id uuid not null references public.customers(id) on delete cascade,
  quote_id uuid references public.quotes(id) on delete set null,
  title text not null,
  details text,
  service_type text,
  amount numeric not null default 0,
  status text not null default 'scheduled' check (status in ('scheduled','in_progress','completed','cancelled')),
  scheduled_date date,
  technician_id uuid references public.profiles(id) on delete set null,
  completed_at timestamptz,
  created_at timestamptz not null default now()
);

create table if not exists public.invoices (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references public.businesses(id) on delete cascade,
  customer_id uuid not null references public.customers(id) on delete cascade,
  job_id uuid references public.jobs(id) on delete set null,
  title text not null,
  amount numeric not null default 0,
  status text not null default 'unpaid' check (status in ('unpaid','paid','void')),
  issued_at timestamptz not null default now(),
  paid_at timestamptz
);

create table if not exists public.equipment (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references public.businesses(id) on delete cascade,
  customer_id uuid not null references public.customers(id) on delete cascade,
  body_id uuid references public.bodies_of_water(id) on delete set null,
  name text not null,
  kind text,
  installed_on date,
  last_serviced_on date,
  service_interval_days integer not null default 90,
  notes text,
  photo_path text,
  created_at timestamptz not null default now()
);

alter table public.quotes enable row level security;
alter table public.jobs enable row level security;
alter table public.invoices enable row level security;
alter table public.equipment enable row level security;

-- quotes + invoices: members read; owner writes (money paperwork stays owner-side)
create policy quo_select on public.quotes for select to authenticated using (business_id = public.my_business_id());
create policy quo_write on public.quotes for all to authenticated
  using (business_id = public.my_business_id() and public.my_role() = 'owner')
  with check (business_id = public.my_business_id() and public.my_role() = 'owner');
create policy inv_select on public.invoices for select to authenticated using (business_id = public.my_business_id());
create policy inv_write on public.invoices for all to authenticated
  using (business_id = public.my_business_id() and public.my_role() = 'owner')
  with check (business_id = public.my_business_id() and public.my_role() = 'owner');

-- jobs: members read; owner creates/deletes; owner or the assigned tech can update (status flow)
create policy job_select on public.jobs for select to authenticated using (business_id = public.my_business_id());
create policy job_insert on public.jobs for insert to authenticated
  with check (business_id = public.my_business_id() and public.my_role() = 'owner');
create policy job_update on public.jobs for update to authenticated
  using (business_id = public.my_business_id() and (public.my_role() = 'owner' or technician_id = auth.uid()))
  with check (business_id = public.my_business_id());
create policy job_delete on public.jobs for delete to authenticated
  using (business_id = public.my_business_id() and public.my_role() = 'owner');

-- equipment: members read; owner writes
create policy equ_select on public.equipment for select to authenticated using (business_id = public.my_business_id());
create policy equ_write on public.equipment for all to authenticated
  using (business_id = public.my_business_id() and public.my_role() = 'owner')
  with check (business_id = public.my_business_id() and public.my_role() = 'owner');

grant select, insert, update, delete on public.quotes, public.jobs, public.invoices, public.equipment to authenticated;
grant select, insert, update, delete on public.quotes, public.jobs, public.invoices, public.equipment to anon;
