begin;

-- Additive migration. Existing leads, membership, recovery, and audit stay intact.
create function public.discovery_normalize(p text) returns text
language sql immutable set search_path = '' as $$
  select regexp_replace(btrim(translate(lower(coalesce(p,'')),
    'áàâãäéèêëíìîïóòôõöúùûüçñ', 'aaaaaeeeeiiiiooooouuuucn')), '\s+', ' ', 'g');
$$;
create function public.discovery_city(p text) returns text
language sql immutable set search_path = '' as $$
  select btrim(regexp_replace(public.discovery_normalize(p), '\s*[,/(-]\s*[a-z]{2}\)?$', ''));
$$;
create function public.discovery_valid_url(p text) returns boolean
language sql immutable set search_path = '' as $$
  select p is not null and length(p)<=1000 and (p='' or
    (p ~ '^https?://[^/[:space:]?#]+' and p !~ '^https?://[^/]*@' and p !~ '[[:cntrl:]]'));
$$;
create function public.discovery_state(p text) returns text
language sql immutable set search_path = '' as $$
  select upper((regexp_match(public.discovery_normalize(p), '[,/(-]\s*([a-z]{2})\)?$'))[1]);
$$;

create table public.discovery_results (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null default auth.uid() references auth.users(id) on delete restrict,
  company text not null check (length(btrim(company)) between 1 and 100),
  city text not null check (length(btrim(city)) between 1 and 70),
  state text not null check (state in ('AC','AL','AP','AM','BA','CE','DF','ES','GO','MA','MT','MS','MG','PA','PB','PR','PE','PI','RJ','RN','RS','RO','RR','SC','SP','SE','TO')),
  sector text not null check (length(btrim(sector)) between 1 and 80),
  contact text not null default '' check (length(contact)<=160),
  website text not null default '' check (public.discovery_valid_url(website)),
  source_kind text not null default 'manual' check (source_kind='manual'),
  source_name text not null check (length(btrim(source_name)) between 1 and 160),
  source_url text not null default '' check (public.discovery_valid_url(source_url)),
  collected_at timestamptz not null check (isfinite(collected_at) and collected_at<=now()+interval '5 minutes'),
  created_at timestamptz not null default now(),
  identity_key text not null,
  unique(owner_id, identity_key),
  check (company || city || sector || contact || source_name !~ '[[:cntrl:]]')
);
create index discovery_results_owner_time on public.discovery_results(owner_id, created_at desc, id);
create index leads_discovery_match on public.leads(owner_id, public.discovery_normalize(company), public.discovery_city(city));

create table public.discovery_origins (
  lead_id uuid primary key references public.leads(id) on delete restrict,
  discovery_result_id uuid not null unique references public.discovery_results(id) on delete restrict,
  owner_id uuid not null default auth.uid() references auth.users(id) on delete restrict,
  added_at timestamptz not null default now()
);
alter table public.discovery_results enable row level security;
alter table public.discovery_origins enable row level security;
create policy discovery_read_own on public.discovery_results for select to authenticated
  using (owner_id=auth.uid() and public.is_active_member());
create policy discovery_insert_own on public.discovery_results for insert to authenticated
  with check (owner_id=auth.uid() and public.is_active_member());
create policy discovery_origins_read_own on public.discovery_origins for select to authenticated
  using (owner_id=auth.uid() and public.is_active_member());
create policy discovery_origins_insert_own on public.discovery_origins for insert to authenticated
  with check (owner_id=auth.uid() and public.is_active_member()
    and exists(select 1 from public.leads where id=lead_id and owner_id=auth.uid())
    and exists(select 1 from public.discovery_results where id=discovery_result_id and owner_id=auth.uid()));
revoke all on public.discovery_results, public.discovery_origins from anon, authenticated;
grant select, insert on public.discovery_results, public.discovery_origins to authenticated;
-- No UPDATE/DELETE: original source and collection time cannot be overwritten.
create function public.guard_discovery_result() returns trigger
language plpgsql set search_path = '' as $$
begin
  new.created_at:=now();
  new.identity_key:=jsonb_build_array(public.discovery_normalize(new.company),public.discovery_normalize(new.city),new.state)::text;
  return new;
end;
$$;
create trigger guard_discovery_result before insert on public.discovery_results
  for each row execute function public.guard_discovery_result();

-- A matching name/city is a potential duplicate, not proof of legal identity.
-- Include archived leads and permanent origin links, even after a lead is renamed.
create function public.discovery_pipeline_match(p_id uuid) returns jsonb
language sql stable security invoker set search_path = '' as $$
  select jsonb_build_object('lead_id',l.id,'archived',l.deleted_at is not null,'linked',o.lead_id is not null)
  from public.discovery_results r
  join public.leads l on l.owner_id=r.owner_id
  left join public.discovery_origins o on o.discovery_result_id=r.id and o.lead_id=l.id
  where r.id=p_id and (o.lead_id is not null or
    (public.discovery_normalize(l.company)=public.discovery_normalize(r.company)
     and public.discovery_city(l.city)=public.discovery_normalize(r.city)
     and (public.discovery_state(l.city) is null or public.discovery_state(l.city)=r.state)))
  order by (o.lead_id is not null) desc, l.created_at, l.id limit 1;
$$;

create function public.list_discovery_results(p_city text default '',p_state text default '',p_sector text default '',p_offset integer default 0)
returns setof jsonb language plpgsql stable security invoker set search_path = '' as $$
begin
  if not public.is_active_member() then raise exception 'Forbidden' using errcode='42501'; end if;
  if p_city is null or length(p_city)>70 or p_sector is null or length(p_sector)>80 or p_state is null
    or (p_state<>'' and p_state not in ('AC','AL','AP','AM','BA','CE','DF','ES','GO','MA','MT','MS','MG','PA','PB','PR','PE','PI','RJ','RN','RS','RO','RR','SC','SP','SE','TO'))
    or p_offset is null or p_offset not between 0 and 10000000 then
    raise exception 'Invalid filters' using errcode='22023';
  end if;
  return query select (to_jsonb(r)-'owner_id'-'identity_key') || jsonb_build_object('pipeline_match',public.discovery_pipeline_match(r.id))
    from public.discovery_results r
    where (p_city='' or public.discovery_normalize(r.city)=public.discovery_normalize(p_city))
      and (p_state='' or r.state=p_state)
      and (p_sector='' or position(public.discovery_normalize(p_sector) in public.discovery_normalize(r.sector))>0)
    order by r.created_at desc,r.id limit 100 offset p_offset;
end;
$$;

create function public.import_discovery_results(p_source jsonb,p_records jsonb,p_commit boolean default false)
returns jsonb language plpgsql security invoker set search_path = '' as $$
declare raw jsonb; identity text; seen text[]:='{}'; new_id uuid;
  total integer:=0; created integer:=0; duplicates integer:=0; collected timestamptz;
begin
  if not public.is_active_member() then raise exception 'Forbidden' using errcode='42501'; end if;
  if jsonb_typeof(p_source) is distinct from 'object' or jsonb_typeof(p_records) is distinct from 'array' then
    raise exception 'Invalid import' using errcode='22023'; end if;
  if p_commit is null or jsonb_array_length(p_records) not between 1 and 500 or octet_length(p_records::text)>2300000
    or jsonb_typeof(p_source->'name') is distinct from 'string' or length(btrim(p_source->>'name')) not between 1 and 160
    or jsonb_typeof(p_source->'url') is distinct from 'string' or not public.discovery_valid_url(p_source->>'url')
    or jsonb_typeof(p_source->'collected_at') is distinct from 'string'
    or (p_source - array['name','url','collected_at'])<>'{}'::jsonb
    or p_source->>'name' ~ '[[:cntrl:]]' then
    raise exception 'Invalid source' using errcode='22023'; end if;
  begin collected:=(p_source->>'collected_at')::timestamptz;
  exception when others then raise exception 'Invalid collection date' using errcode='22023'; end;
  if not isfinite(collected) or collected>now()+interval '5 minutes' then
    raise exception 'Invalid collection date' using errcode='22023'; end if;
  perform pg_advisory_xact_lock(hashtext(auth.uid()::text));
  for raw in select value from jsonb_array_elements(p_records) loop
    total:=total+1;
    if jsonb_typeof(raw) is distinct from 'object'
      or not public.valid_lead_values(raw || '{"site":"unknown","status":"Novo","notes":""}'::jsonb)
      or length(btrim(raw->>'city'))>70 or jsonb_typeof(raw->'sector') is distinct from 'string'
      or length(btrim(raw->>'sector'))<1 or jsonb_typeof(raw->'state') is distinct from 'string'
      or raw->>'state' not in ('AC','AL','AP','AM','BA','CE','DF','ES','GO','MA','MT','MS','MG','PA','PB','PR','PE','PI','RJ','RN','RS','RO','RR','SC','SP','SE','TO')
      or jsonb_typeof(raw->'website') is distinct from 'string' or not public.discovery_valid_url(raw->>'website')
      or (raw - array['company','city','state','sector','contact','website'])<>'{}'::jsonb
      or (raw->>'company') || (raw->>'city') || (raw->>'sector') || coalesce(raw->>'contact','') ~ '[[:cntrl:]]' then
      raise exception 'Invalid row %',total using errcode='22023'; end if;
    identity:=jsonb_build_array(public.discovery_normalize(raw->>'company'),public.discovery_normalize(raw->>'city'),raw->>'state')::text;
    if identity=any(seen) or exists(select 1 from public.discovery_results where identity_key=identity) then
      duplicates:=duplicates+1; continue;
    end if;
    if p_commit then
      new_id:=null;
      insert into public.discovery_results(company,city,state,sector,contact,website,source_name,source_url,collected_at)
        values(btrim(raw->>'company'),btrim(raw->>'city'),raw->>'state',btrim(raw->>'sector'),btrim(coalesce(raw->>'contact','')),
          raw->>'website',btrim(p_source->>'name'),p_source->>'url',collected)
        on conflict do nothing returning id into new_id;
      if new_id is null then duplicates:=duplicates+1; continue; end if;
    end if;
    seen:=array_append(seen,identity); created:=created+1;
  end loop;
  return jsonb_build_object('total',total,'created',created,'duplicates',duplicates,'committed',p_commit);
end;
$$;

create function public.promote_discovery_result(p_id uuid) returns jsonb
language plpgsql security invoker set search_path = '' as $$
declare r public.discovery_results; matched jsonb; new_id uuid;
begin
  if not public.is_active_member() then raise exception 'Forbidden' using errcode='42501'; end if;
  perform pg_advisory_xact_lock(hashtext(auth.uid()::text));
  select * into r from public.discovery_results where id=p_id;
  if r.id is null then raise exception 'Unavailable result' using errcode='42501'; end if;
  matched:=public.discovery_pipeline_match(p_id);
  if matched is not null then return matched || jsonb_build_object('outcome',
    case when (matched->>'linked')::boolean then 'already_added' else 'duplicate' end); end if;
  insert into public.leads(company,city,sector,contact,site,status,notes)
    values(r.company,r.city || ', ' || r.state,r.sector,r.contact,'unknown','Novo','')
    on conflict do nothing returning id into new_id;
  if new_id is null then raise exception 'Concurrent change' using errcode='40001'; end if;
  insert into public.discovery_origins(lead_id,discovery_result_id) values(new_id,r.id);
  return jsonb_build_object('outcome','added','lead_id',new_id,'archived',false);
end;
$$;

revoke all on function public.guard_discovery_result() from public;
revoke all on function public.discovery_normalize(text),public.discovery_city(text),public.discovery_state(text),public.discovery_valid_url(text),
  public.discovery_pipeline_match(uuid),public.list_discovery_results(text,text,text,integer),
  public.import_discovery_results(jsonb,jsonb,boolean),public.promote_discovery_result(uuid) from public;
grant execute on function public.discovery_normalize(text),public.discovery_city(text),public.discovery_state(text),public.discovery_valid_url(text),
  public.discovery_pipeline_match(uuid),public.list_discovery_results(text,text,text,integer),
  public.import_discovery_results(jsonb,jsonb,boolean),public.promote_discovery_result(uuid) to authenticated;
commit;
