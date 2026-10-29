begin;

-- Intentionally fail if these application tables already exist. Never replace user data.
create table public.app_members (
  user_id uuid primary key references auth.users(id) on delete restrict,
  active boolean not null default false
);

create function public.is_active_member() returns boolean
language sql stable security definer set search_path = '' as $$
  select exists(select 1 from public.app_members where user_id = auth.uid() and active);
$$;
revoke all on function public.is_active_member() from public;
grant execute on function public.is_active_member() to authenticated;

create function public.lead_identity(p jsonb) returns text
language sql immutable set search_path = '' as $$
  select jsonb_build_array(
    lower(regexp_replace(btrim(p->>'company'), '\s+', ' ', 'g')),
    lower(regexp_replace(btrim(p->>'city'), '\s+', ' ', 'g')),
    lower(regexp_replace(btrim(coalesce(p->>'sector', '')), '\s+', ' ', 'g')),
    lower(regexp_replace(btrim(coalesce(p->>'contact', '')), '\s+', ' ', 'g'))
  )::text;
$$;

create function public.lead_values(p jsonb) returns jsonb
language sql immutable set search_path = '' as $$
  select jsonb_build_object(
    'company', btrim(p->>'company'), 'city', btrim(p->>'city'),
    'sector', btrim(coalesce(p->>'sector', '')), 'contact', btrim(coalesce(p->>'contact', '')),
    'site', coalesce(p->>'site', 'unknown'), 'status', p->>'status',
    'notes', btrim(coalesce(p->>'notes', ''))
  );
$$;

create function public.valid_lead_values(p jsonb) returns boolean
language sql immutable set search_path = '' as $$
  select coalesce(jsonb_typeof(p) = 'object'
    and jsonb_typeof(p->'company') = 'string' and length(btrim(p->>'company')) between 1 and 100
    and jsonb_typeof(p->'city') = 'string' and length(btrim(p->>'city')) between 1 and 80
    and (not p ? 'sector' or (jsonb_typeof(p->'sector') = 'string' and length(p->>'sector') <= 80))
    and (not p ? 'contact' or (jsonb_typeof(p->'contact') = 'string' and length(p->>'contact') <= 160))
    and (not p ? 'notes' or (jsonb_typeof(p->'notes') = 'string' and length(p->>'notes') <= 600))
    and (not p ? 'site' or p->>'site' in ('unknown', 'none', 'basic', 'good'))
    and p->>'status' in ('Novo', 'Contato preparado', 'Em negociação', 'Fechado'), false);
$$;

create table public.leads (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null default auth.uid() references auth.users(id) on delete restrict,
  company text not null check (length(btrim(company)) between 1 and 100),
  city text not null check (length(btrim(city)) between 1 and 80),
  sector text not null default '' check (length(sector) <= 80),
  contact text not null default '' check (length(contact) <= 160),
  site text not null default 'unknown' check (site in ('unknown', 'none', 'basic', 'good')),
  status text not null default 'Novo' check (status in ('Novo', 'Contato preparado', 'Em negociação', 'Fechado')),
  notes text not null default '' check (length(notes) <= 600),
  legacy_id text check (length(btrim(legacy_id)) between 1 and 200),
  legacy_snapshot jsonb,
  source text not null default 'manual' check (source in ('manual', 'v1_import')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,
  version integer not null default 1 check (version > 0),
  identity_key text not null,
  unique (owner_id, legacy_id),
  unique (owner_id, identity_key),
  check ((source = 'manual' and legacy_id is null and legacy_snapshot is null)
    or (source = 'v1_import' and legacy_id is not null and legacy_snapshot is not null and jsonb_typeof(legacy_snapshot) = 'object'))
);
create index leads_owner_created on public.leads(owner_id, created_at desc, id);

create table public.lead_events (
  id uuid primary key default gen_random_uuid(),
  lead_id uuid not null references public.leads(id) on delete restrict,
  owner_id uuid not null references auth.users(id) on delete restrict,
  actor_id uuid not null references auth.users(id) on delete restrict,
  action text not null check (action in ('created', 'imported', 'updated', 'archived', 'restored')),
  occurred_at timestamptz not null default now(),
  before_data jsonb,
  after_data jsonb not null
);
create index lead_events_lead_time on public.lead_events(lead_id, occurred_at desc, id);

alter table public.app_members enable row level security;
alter table public.leads enable row level security;
alter table public.lead_events enable row level security;
create policy member_read_self on public.app_members for select to authenticated using (user_id = auth.uid());
create policy leads_read_own on public.leads for select to authenticated using (owner_id = auth.uid() and public.is_active_member());
create policy leads_insert_own on public.leads for insert to authenticated with check (owner_id = auth.uid() and public.is_active_member());
create policy leads_update_own on public.leads for update to authenticated
  using (owner_id = auth.uid() and public.is_active_member())
  with check (owner_id = auth.uid() and public.is_active_member());
create policy events_read_own on public.lead_events for select to authenticated using (owner_id = auth.uid() and public.is_active_member());
revoke all on public.app_members, public.leads, public.lead_events from anon, authenticated;
grant select on public.app_members, public.leads, public.lead_events to authenticated;
grant insert, update on public.leads to authenticated;
-- No client may hard-delete leads or write/change/delete audit events.

create function public.guard_lead() returns trigger
language plpgsql set search_path = '' as $$
begin
  if tg_op = 'INSERT' then
    new.created_at := now(); new.updated_at := now(); new.version := 1; new.deleted_at := null;
  else
    if new.id is distinct from old.id or new.owner_id is distinct from old.owner_id
      or new.created_at is distinct from old.created_at or new.legacy_id is distinct from old.legacy_id
      or new.legacy_snapshot is distinct from old.legacy_snapshot or new.source is distinct from old.source then
      raise exception 'Immutable provenance' using errcode = '22023';
    end if;
    new.updated_at := now(); new.version := old.version + 1;
  end if;
  new.identity_key := public.lead_identity(to_jsonb(new));
  return new;
end;
$$;
create trigger guard_lead before insert or update on public.leads for each row execute function public.guard_lead();

create function public.audit_lead() returns trigger
language plpgsql security definer set search_path = '' as $$
declare kind text;
begin
  kind := case when tg_op = 'INSERT' and new.source = 'v1_import' then 'imported'
    when tg_op = 'INSERT' then 'created'
    when old.deleted_at is null and new.deleted_at is not null then 'archived'
    when old.deleted_at is not null and new.deleted_at is null then 'restored'
    else 'updated' end;
  insert into public.lead_events(lead_id, owner_id, actor_id, action, before_data, after_data)
    values(new.id, new.owner_id, auth.uid(), kind,
      case when tg_op = 'UPDATE' then to_jsonb(old) - 'identity_key' else null end,
      to_jsonb(new) - 'identity_key');
  return new;
end;
$$;
revoke all on function public.guard_lead(), public.audit_lead() from public;
create trigger audit_lead after insert or update on public.leads for each row execute function public.audit_lead();

create function public.update_lead(p_id uuid, p_version integer, p_values jsonb, p_archived boolean default null)
returns public.leads language plpgsql security invoker set search_path = '' as $$
declare result public.leads; v jsonb;
begin
  if not public.valid_lead_values(p_values) then raise exception 'Invalid values' using errcode = '22023'; end if;
  v := public.lead_values(p_values);
  update public.leads set company=v->>'company', city=v->>'city', sector=v->>'sector', contact=v->>'contact',
    site=v->>'site', status=v->>'status', notes=v->>'notes',
    deleted_at=case when p_archived is null then deleted_at when p_archived then now() else null end
    where id=p_id and version=p_version
    returning * into result;
  if result.id is null then raise exception 'Record changed or unavailable' using errcode = '40001'; end if;
  return result;
end;
$$;
revoke all on function public.update_lead(uuid, integer, jsonb, boolean) from public;
grant execute on function public.update_lead(uuid, integer, jsonb, boolean) to authenticated;

create function public.import_leads_v1(p_records jsonb, p_commit boolean default false)
returns jsonb language plpgsql security invoker set search_path = '' as $$
declare
  raw jsonb; v jsonb; existing jsonb; seen jsonb := '{}'::jsonb; identity text; legacy text;
  row_number integer := 0; created integer := 0; duplicates integer := 0; conflicts integer := 0;
  conflict_rows jsonb := '[]'::jsonb; new_id uuid;
begin
  if not public.is_active_member() then raise exception 'Forbidden' using errcode='42501'; end if;
  if jsonb_typeof(p_records) is distinct from 'array' then raise exception 'Invalid backup' using errcode='22023'; end if;
  if jsonb_array_length(p_records) not between 1 and 5000 or octet_length(p_records::text)>2300000 or p_commit is null then
    raise exception 'Backup exceeds limits' using errcode='22023';
  end if;
  -- Serialize imports by user. Unique constraints also protect simultaneous manual creation.
  perform pg_advisory_xact_lock(hashtext(auth.uid()::text));
  for raw in select value from jsonb_array_elements(p_records) loop
    row_number := row_number + 1;
    if not public.valid_lead_values(raw) or jsonb_typeof(raw->'id') is distinct from 'string'
      or length(btrim(raw->>'id')) not between 1 and 200 then
      raise exception 'Invalid row %', row_number using errcode='22023';
    end if;
    v := public.lead_values(raw); legacy := btrim(raw->>'id'); identity := public.lead_identity(v);
    select public.lead_values(to_jsonb(l)) into existing from public.leads l where legacy_id=legacy or id::text=legacy limit 1;
    if existing is null then
      select public.lead_values(to_jsonb(l)) into existing from public.leads l where identity_key=identity limit 1;
    end if;
    existing := coalesce(existing, seen->('id:' || legacy), seen->('key:' || identity));
    if existing is not null then
      if existing=v then duplicates := duplicates+1;
      else conflicts:=conflicts+1; conflict_rows:=conflict_rows || to_jsonb(row_number); end if;
      continue;
    end if;
    if p_commit then
      new_id := null;
      insert into public.leads(company,city,sector,contact,site,status,notes,legacy_id,legacy_snapshot,source)
        values(v->>'company',v->>'city',v->>'sector',v->>'contact',v->>'site',v->>'status',v->>'notes',legacy,raw,'v1_import')
        on conflict do nothing returning id into new_id;
      if new_id is null then
        conflicts:=conflicts+1; conflict_rows:=conflict_rows || to_jsonb(row_number); continue;
      end if;
    end if;
    created:=created+1;
    seen := seen || jsonb_build_object('id:' || legacy,v,'key:' || identity,v);
  end loop;
  return jsonb_build_object('total',row_number,'created',created,'duplicates',duplicates,
    'conflicts',conflicts,'conflict_rows',conflict_rows,'committed',p_commit);
end;
$$;
revoke all on function public.import_leads_v1(jsonb, boolean) from public;
grant execute on function public.import_leads_v1(jsonb, boolean) to authenticated;
revoke all on function public.lead_identity(jsonb), public.lead_values(jsonb), public.valid_lead_values(jsonb) from public;
grant execute on function public.lead_identity(jsonb), public.lead_values(jsonb), public.valid_lead_values(jsonb) to authenticated;
commit;
