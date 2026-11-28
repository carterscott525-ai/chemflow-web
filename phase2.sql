-- ChemFlow Web — Phase 2 migration (run once on the live project)
-- Business ops: quotes -> jobs -> invoices, equipment + due tracking.
-- (Also appended to schema.sql for fresh installs.)

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
