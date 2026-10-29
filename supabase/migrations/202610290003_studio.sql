begin;
-- Additive only. No changes to CRM, discovery, Auth, or existing records.
create function public.studio_valid_fields(p jsonb,p_mode text) returns boolean
language plpgsql immutable set search_path='' as $$
declare k text; f jsonb; max_len integer;
  keys constant text[]:=array['company','sector','city','services','audience','differentiators','visual_identity','colors','site_style','visual_references','features','contacts','creative_notes'];
begin
  if p_mode is null or p_mode not in ('opportunity','demo') or jsonb_typeof(p) is distinct from 'object'
    or octet_length(p::text)>131072 or (p-keys)<>'{}'::jsonb then return false; end if;
  foreach k in array keys loop
    f:=p->k; max_len:=case when k='company' then 100 when k in ('city','sector') then 80 when k='contacts' then 2000 else 4000 end;
    if jsonb_typeof(f) is distinct from 'object' or (f-array['value','source','verification','public_use'])<>'{}'::jsonb
      or jsonb_typeof(f->'value') is distinct from 'string' or length(f->>'value')>max_len
      or jsonb_typeof(f->'source') is distinct from 'string' or length(f->>'source')>500
      or jsonb_typeof(f->'verification') is distinct from 'string' or f->>'verification' not in ('pending','verified','fictional')
      or jsonb_typeof(f->'public_use') is distinct from 'boolean'
      or (f->>'value') || (f->>'source') ~ '[\x01-\x08\x0B\x0C\x0E-\x1F\x7F]'
      or (p_mode='opportunity' and f->>'verification'='fictional') then return false; end if;
    if f->>'verification'<>'pending' and (length(btrim(f->>'value'))=0 or length(btrim(f->>'source'))=0) then return false; end if;
    if (f->>'public_use')::boolean and (length(btrim(f->>'value'))=0 or f->>'verification'='pending' or k='creative_notes') then return false; end if;
  end loop;
  return true;
end;
$$;
create function public.studio_brief_hash(p jsonb) returns text
language sql immutable set search_path='' as $$select encode(sha256(convert_to(p::text,'UTF8')),'hex');$$;

create table public.studio_projects (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references auth.users(id) on delete restrict,
  title text not null check(length(btrim(title)) between 1 and 120),
  mode text not null check(mode in ('opportunity','demo')),
  lead_id uuid references public.leads(id) on delete restrict,
  lead_snapshot jsonb,
  head_id uuid,
  request_id uuid not null,
  created_at timestamptz not null default now(),
  unique(owner_id,id), unique(owner_id,request_id),
  check ((mode='demo' and lead_id is null and lead_snapshot is null)
    or (mode='opportunity' and lead_id is not null and jsonb_typeof(lead_snapshot)='object'))
);
create table public.studio_brief_versions (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references auth.users(id) on delete restrict,
  project_id uuid not null,
  number integer not null check(number>0),
  parent_id uuid,
  fields jsonb not null check(public.studio_valid_fields(fields,'demo')),
  content_hash text not null check(content_hash=public.studio_brief_hash(fields)),
  request_id uuid not null,
  created_by uuid not null references auth.users(id) on delete restrict check(created_by=owner_id),
  created_at timestamptz not null default now(),
  foreign key(owner_id,project_id) references public.studio_projects(owner_id,id) on delete restrict,
  unique(project_id,id), unique(project_id,number), unique(project_id,request_id), unique(owner_id,project_id,id,content_hash),
  foreign key(project_id,parent_id) references public.studio_brief_versions(project_id,id) on delete restrict
);
alter table public.studio_projects add constraint studio_head_project_fk
  foreign key(id,head_id) references public.studio_brief_versions(project_id,id) on delete restrict;
create table public.studio_brief_approvals (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references auth.users(id) on delete restrict,
  project_id uuid not null,
  version_id uuid not null unique,
  content_hash text not null,
  actor_id uuid not null references auth.users(id) on delete restrict check(actor_id=owner_id),
  created_at timestamptz not null default now(),
  foreign key(owner_id,project_id,version_id,content_hash)
    references public.studio_brief_versions(owner_id,project_id,id,content_hash) on delete restrict
);
create index studio_projects_owner_time on public.studio_projects(owner_id,created_at desc,id);
create index studio_briefs_project_number on public.studio_brief_versions(project_id,number desc);
alter table public.studio_projects enable row level security;
alter table public.studio_brief_versions enable row level security;
alter table public.studio_brief_approvals enable row level security;
create policy studio_projects_read_own on public.studio_projects for select to authenticated using(owner_id=auth.uid() and public.is_active_member());
create policy studio_briefs_read_own on public.studio_brief_versions for select to authenticated using(owner_id=auth.uid() and public.is_active_member());
create policy studio_approvals_read_own on public.studio_brief_approvals for select to authenticated using(owner_id=auth.uid() and public.is_active_member());
revoke all on public.studio_projects,public.studio_brief_versions,public.studio_brief_approvals from anon,authenticated;
grant select on public.studio_projects,public.studio_brief_versions,public.studio_brief_approvals to authenticated;
-- All writes go through narrowly scoped RPCs below, never direct table mutation.
create function public.studio_deny_rewrite() returns trigger
language plpgsql set search_path='' as $$begin raise exception 'Immutable studio record' using errcode='22023'; end;$$;
create trigger studio_briefs_immutable before update or delete on public.studio_brief_versions for each row execute function public.studio_deny_rewrite();
create trigger studio_approvals_immutable before update or delete on public.studio_brief_approvals for each row execute function public.studio_deny_rewrite();

create function public.studio_seed_fields(p_snapshot jsonb) returns jsonb
language plpgsql immutable set search_path='' as $$
declare k text; v text; result jsonb:='{}';
begin
  foreach k in array array['company','sector','city','services','audience','differentiators','visual_identity','colors','site_style','visual_references','features','contacts','creative_notes'] loop
    v:=case when k='contacts' then coalesce(p_snapshot->>'contact','') when k in ('company','sector','city') then coalesce(p_snapshot->>k,'') else '' end;
    result:=result||jsonb_build_object(k,jsonb_build_object('value',v,'source',case when v<>'' then 'Oportunidade cadastrada — snapshot da criação' else '' end,'verification','pending','public_use',false));
  end loop;
  return result;
end;$$;

-- Definer mutations: no owner/actor parameters, fixed search_path, explicit
-- auth.uid()+active-membership+ownership checks before every read/write.
create function public.studio_create_project(p_title text,p_mode text,p_lead_id uuid,p_request_id uuid) returns jsonb
language plpgsql security definer set search_path='' as $$
declare actor uuid:=auth.uid(); existing public.studio_projects; snapshot jsonb; project uuid:=gen_random_uuid(); version uuid:=gen_random_uuid(); fields jsonb;
begin
  if actor is null or not public.is_active_member() then raise exception 'Forbidden' using errcode='42501'; end if;
  if p_title is null or length(btrim(p_title)) not between 1 and 120 or p_title ~ '[\x01-\x1F\x7F]'
    or p_mode is null or p_mode not in ('opportunity','demo') or p_request_id is null
    or (p_mode='demo' and p_lead_id is not null) or (p_mode='opportunity' and p_lead_id is null) then
    raise exception 'Invalid project' using errcode='22023'; end if;
  perform pg_advisory_xact_lock(hashtext('studio:'||actor::text));
  select * into existing from public.studio_projects where owner_id=actor and request_id=p_request_id;
  if existing.id is not null then
    if existing.title<>btrim(p_title) or existing.mode<>p_mode or existing.lead_id is distinct from p_lead_id then raise exception 'Request reused' using errcode='22023'; end if;
    return jsonb_build_object('project_id',existing.id,'version_id',existing.head_id);
  end if;
  if p_mode='opportunity' then
    select jsonb_build_object('id',l.id,'company',l.company,'sector',l.sector,'city',l.city,'contact',l.contact,'version',l.version,'source',l.source,
      'discovery', (select jsonb_build_object('source_name',r.source_name,'source_url',r.source_url,'collected_at',r.collected_at,'website',r.website)
        from public.discovery_origins o join public.discovery_results r on r.id=o.discovery_result_id and r.owner_id=actor
        where o.lead_id=l.id and o.owner_id=actor))
      into snapshot from public.leads l where l.id=p_lead_id and l.owner_id=actor and l.deleted_at is null;
    if snapshot is null then raise exception 'Unavailable opportunity' using errcode='42501'; end if;
  end if;
  fields:=public.studio_seed_fields(snapshot);
  insert into public.studio_projects(id,owner_id,title,mode,lead_id,lead_snapshot,request_id) values(project,actor,btrim(p_title),p_mode,p_lead_id,snapshot,p_request_id);
  insert into public.studio_brief_versions(id,owner_id,project_id,number,fields,content_hash,request_id,created_by)
    values(version,actor,project,1,fields,public.studio_brief_hash(fields),p_request_id,actor);
  update public.studio_projects set head_id=version where id=project and owner_id=actor;
  return jsonb_build_object('project_id',project,'version_id',version);
end;$$;

create function public.studio_save_brief(p_id uuid,p_expected_head uuid,p_fields jsonb,p_request_id uuid) returns jsonb
language plpgsql security definer set search_path='' as $$
declare actor uuid:=auth.uid(); project public.studio_projects; existing public.studio_brief_versions; next_number integer; version uuid:=gen_random_uuid();
begin
  if actor is null or not public.is_active_member() then raise exception 'Forbidden' using errcode='42501'; end if;
  select * into project from public.studio_projects where id=p_id and owner_id=actor for update;
  if project.id is null then raise exception 'Unavailable project' using errcode='42501'; end if;
  if p_request_id is null or not public.studio_valid_fields(p_fields,project.mode) then raise exception 'Invalid briefing' using errcode='22023'; end if;
  select * into existing from public.studio_brief_versions where owner_id=actor and project_id=p_id and request_id=p_request_id;
  if existing.id is not null then
    if existing.fields<>p_fields or existing.parent_id is distinct from p_expected_head then raise exception 'Request reused' using errcode='22023'; end if;
    return jsonb_build_object('version_id',existing.id,'number',existing.number);
  end if;
  if p_expected_head is distinct from project.head_id then raise exception 'Briefing changed' using errcode='40001'; end if;
  select number+1 into next_number from public.studio_brief_versions where id=project.head_id and project_id=p_id and owner_id=actor;
  insert into public.studio_brief_versions(id,owner_id,project_id,number,parent_id,fields,content_hash,request_id,created_by)
    values(version,actor,p_id,next_number,project.head_id,p_fields,public.studio_brief_hash(p_fields),p_request_id,actor);
  update public.studio_projects set head_id=version where id=p_id and owner_id=actor;
  return jsonb_build_object('version_id',version,'number',next_number);
end;$$;

create function public.studio_approve_brief(p_id uuid,p_version_id uuid,p_content_hash text) returns jsonb
language plpgsql security definer set search_path='' as $$
declare actor uuid:=auth.uid(); project public.studio_projects; version public.studio_brief_versions; k text; approval public.studio_brief_approvals;
begin
  if actor is null or not public.is_active_member() then raise exception 'Forbidden' using errcode='42501'; end if;
  select * into project from public.studio_projects where id=p_id and owner_id=actor for update;
  if project.id is null then raise exception 'Unavailable project' using errcode='42501'; end if;
  select * into version from public.studio_brief_versions where id=p_version_id and project_id=p_id and owner_id=actor;
  if version.id is null then raise exception 'Unavailable version' using errcode='42501'; end if;
  if project.head_id<>version.id or p_content_hash is distinct from version.content_hash then raise exception 'Briefing changed' using errcode='40001'; end if;
  foreach k in array array['company','sector','city','services','audience','differentiators','visual_identity','colors','site_style','visual_references','features','contacts','creative_notes'] loop
    if (k in ('company','sector','city','services','audience') and length(btrim(version.fields->k->>'value'))=0)
      or (length(btrim(version.fields->k->>'value'))>0 and (version.fields->k->>'verification'='pending' or length(btrim(version.fields->k->>'source'))=0)) then
      raise exception 'Briefing not reviewed' using errcode='22023'; end if;
  end loop;
  insert into public.studio_brief_approvals(owner_id,project_id,version_id,content_hash,actor_id) values(actor,p_id,version.id,version.content_hash,actor)
    on conflict(version_id) do nothing;
  select * into approval from public.studio_brief_approvals where owner_id=actor and version_id=version.id and project_id=p_id;
  return to_jsonb(approval)-'owner_id';
end;$$;

create function public.studio_version_json(p_id uuid) returns jsonb
language sql stable security invoker set search_path='' as $$
  select (to_jsonb(v)-'owner_id'-'request_id')||jsonb_build_object('approval',(select to_jsonb(a)-'owner_id' from public.studio_brief_approvals a where a.version_id=v.id))
    from public.studio_brief_versions v where v.id=p_id;
$$;
create function public.studio_project_detail(p_id uuid,p_version_id uuid default null) returns jsonb
language plpgsql stable security invoker set search_path='' as $$
declare project public.studio_projects; version jsonb;
begin
  if not public.is_active_member() then raise exception 'Forbidden' using errcode='42501'; end if;
  select * into project from public.studio_projects where id=p_id;
  if project.id is null then raise exception 'Unavailable project' using errcode='42501'; end if;
  select public.studio_version_json(id) into version from public.studio_brief_versions where project_id=p_id and id=coalesce(p_version_id,project.head_id);
  if version is null then raise exception 'Unavailable version' using errcode='42501'; end if;
  return jsonb_build_object('project',to_jsonb(project)-'owner_id'-'request_id','version',version);
end;$$;
create function public.studio_list_projects(p_offset integer default 0) returns setof jsonb
language plpgsql stable security invoker set search_path='' as $$
begin
  if not public.is_active_member() then raise exception 'Forbidden' using errcode='42501'; end if;
  if p_offset is null or p_offset not between 0 and 10000000 then raise exception 'Invalid page' using errcode='22023'; end if;
  return query select (to_jsonb(p)-'owner_id'-'request_id')||jsonb_build_object('head_approved',exists(select 1 from public.studio_brief_approvals where version_id=p.head_id))
    from public.studio_projects p order by p.created_at desc,p.id limit 50 offset p_offset;
end;$$;
create function public.studio_list_briefs(p_id uuid,p_offset integer default 0) returns setof jsonb
language plpgsql stable security invoker set search_path='' as $$
begin
  if not public.is_active_member() or not exists(select 1 from public.studio_projects where id=p_id) then raise exception 'Unavailable project' using errcode='42501'; end if;
  if p_offset is null or p_offset not between 0 and 10000000 then raise exception 'Invalid page' using errcode='22023'; end if;
  return query select public.studio_version_json(v.id)-'fields' from public.studio_brief_versions v where v.project_id=p_id order by v.number desc limit 50 offset p_offset;
end;$$;

revoke all on function public.studio_valid_fields(jsonb,text),public.studio_brief_hash(jsonb),public.studio_deny_rewrite(),public.studio_seed_fields(jsonb),
  public.studio_create_project(text,text,uuid,uuid),public.studio_save_brief(uuid,uuid,jsonb,uuid),public.studio_approve_brief(uuid,uuid,text),
  public.studio_version_json(uuid),public.studio_project_detail(uuid,uuid),public.studio_list_projects(integer),public.studio_list_briefs(uuid,integer) from public;
grant execute on function public.studio_create_project(text,text,uuid,uuid),public.studio_save_brief(uuid,uuid,jsonb,uuid),public.studio_approve_brief(uuid,uuid,text),
  public.studio_version_json(uuid),public.studio_project_detail(uuid,uuid),public.studio_list_projects(integer),public.studio_list_briefs(uuid,integer) to authenticated;
commit;
