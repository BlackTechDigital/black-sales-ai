begin;
-- Stage 2 only. All objects are NEW; no replacement of existing functions,
-- tables, policies, rows, Auth configuration, buckets, or credentials.

create function public.studio_site_trim(p text) returns text
language sql immutable set search_path='' as $$
  select btrim(p,U&'\0009\000A\000B\000C\000D\0020\00A0\1680\2000\2001\2002\2003\2004\2005\2006\2007\2008\2009\200A\2028\2029\202F\205F\3000\FEFF');
$$;
create function public.studio_site_keys(p jsonb,allowed text[],required text[]) returns boolean
language sql immutable set search_path='' as $$
  select coalesce(jsonb_typeof(p)='object' and p-allowed='{}'::jsonb and p ?& required,false);
$$;
create function public.studio_site_text(p jsonb,max_length integer) returns boolean
language sql immutable set search_path='' as $$
  select coalesce(jsonb_typeof(p)='string' and length(v)>0
    and length(v)<=max_length
    and v !~ '[<>\x01-\x08\x0B\x0C\x0E-\x1F\x7F]',false)
  from (select public.studio_site_trim(p #>> '{}') as v) s;
$$;
create function public.studio_site_json_compact(p jsonb) returns text
language plpgsql immutable set search_path='' as $$
declare result text;
begin
  if jsonb_typeof(p)='object' then
    select '{'||coalesce(string_agg(to_jsonb(key)::text||':'||public.studio_site_json_compact(value),',' order by key),'')||'}' into result from jsonb_each(p);
  elsif jsonb_typeof(p)='array' then
    select '['||coalesce(string_agg(public.studio_site_json_compact(value),',' order by n),'')||']' into result from jsonb_array_elements(p) with ordinality a(value,n);
  else result:=p::text; end if;
  return result;
end;$$;
create function public.studio_site_link_valid(p jsonb) returns boolean
language plpgsql immutable set search_path='' as $$
declare v text; host text;
begin
  if jsonb_typeof(p) is distinct from 'string' then return false; end if;
  v:=p #>> '{}';
  if length(v) not between 1 and 2048 or v ~ '[ \\<>"''`\x01-\x1F\x7F]'
    or v ~ U&'[\00A0\1680\2000\2001\2002\2003\2004\2005\2006\2007\2008\2009\200A\2028\2029\202F\205F\3000\FEFF]'
    or v ~* '%(0[0-9a-f]|1[0-9a-f]|7f)' then return false; end if;
  if v like '#%' then return substring(v from 2) ~ '^[a-z][a-z0-9]*(-[a-z0-9]+)*$'; end if;
  if v like '/%' then return split_part(v,'#',1) ~ '^/([a-z0-9]+(-[a-z0-9]+)*(/[a-z0-9]+(-[a-z0-9]+)*)*)?$'
    and length(split_part(v,'#',1))<=160 and (position('#' in v)=0 or split_part(v,'#',2) ~ '^[a-z][a-z0-9]*(-[a-z0-9]+)*$')
    and length(v)-length(replace(v,'#',''))<=1; end if;
  if v like 'tel:%' then return v ~ '^tel:\+?[0-9]{8,15}$'; end if;
  if v like 'mailto:%' then
    if v !~ '^mailto:([a-zA-Z0-9_+-]+\.)*[a-zA-Z0-9_+-]+@[a-zA-Z0-9.-]+$' or v ~ '[?%#]' then return false; end if;
    host:=split_part(v,'@',2);
  elsif v like 'https://%' then
    host:=substring(v from '^https://([^/?#]+)');
    if host like '%:443' then host:=left(host,-4); end if;
  else return false; end if;
  return coalesce(host ~* '^([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$'
    and host !~* '(^|\.)(localhost|local|internal|lan|home|test|invalid|onion)$',false);
end;$$;
create function public.studio_site_document_valid(p jsonb) returns boolean
language plpgsql immutable set search_path='' as $$
declare identity jsonb; page jsonb; section jsonb; visual jsonb; item jsonb; button jsonb; raw jsonb; k text;
  pages jsonb; keys text[]; required text[]; paths text[]:='{}'; ids text[]; page_ids text[]:='{}'; total integer:=0;
  href text; target_path text; anchor text; target jsonb;
begin
  -- Bound before traversing; compact JSON has the same 128 KiB ceiling as Stage 1.
  if p is null or octet_length(p::text)>196608 or not public.studio_site_keys(p,array['schema_version','identity','pages'],array['schema_version','identity','pages'])
    or p->'schema_version'<>'1'::jsonb then return false; end if;
  identity:=p->'identity';pages:=p->'pages';
  if not public.studio_site_keys(identity,array['business_name','tagline','palette','typography','style','corners'],array['business_name','palette','typography','style','corners'])
    or not public.studio_site_text(identity->'business_name',100)
    or (identity ? 'tagline' and not public.studio_site_text(identity->'tagline',160))
    or coalesce(identity->>'style','') not in ('minimal','editorial','bold','classic') or coalesce(identity->>'corners','') not in ('square','subtle','rounded') then return false; end if;
  if not public.studio_site_keys(identity->'palette',array['background','foreground','primary','accent'],array['background','foreground','primary','accent'])
    or not public.studio_site_keys(identity->'typography',array['heading','body'],array['heading','body']) then return false; end if;
  foreach k in array array['background','foreground','primary','accent'] loop
    if jsonb_typeof(identity->'palette'->k) is distinct from 'string' or identity->'palette'->>k !~ '^#[0-9a-fA-F]{6}$' then return false; end if;
  end loop;
  foreach k in array array['heading','body'] loop
    if coalesce(identity->'typography'->>k,'') not in ('system-sans','system-serif') then return false; end if;
  end loop;
  if jsonb_typeof(pages) is distinct from 'array' then return false; end if;
  if jsonb_array_length(pages) not between 1 and 5 then return false; end if;
  for page in select value from jsonb_array_elements(pages) loop
    if not public.studio_site_keys(page,array['id','path','title','description','sections'],array['id','path','title','description','sections'])
      or jsonb_typeof(page->'id') is distinct from 'string' or length(page->>'id')>64 or page->>'id' !~ '^[a-z][a-z0-9]*(-[a-z0-9]+)*$'
      or jsonb_typeof(page->'path') is distinct from 'string' or length(page->>'path')>160 or page->>'path' !~ '^/([a-z0-9]+(-[a-z0-9]+)*(/[a-z0-9]+(-[a-z0-9]+)*)*)?$'
      or not public.studio_site_text(page->'title',80) or not public.studio_site_text(page->'description',320)
      or jsonb_typeof(page->'sections') is distinct from 'array' then return false; end if;
    if page->>'path'=any(paths) or page->>'id'=any(page_ids) or jsonb_array_length(page->'sections') not between 1 and 12 then return false; end if;
    paths:=array_append(paths,page->>'path');page_ids:=array_append(page_ids,page->>'id');ids:='{}';
    if page->'sections'->0->>'type' is distinct from 'hero' then return false; end if;
    for section in select value from jsonb_array_elements(page->'sections') loop
      total:=total+1;
      if total>40 or jsonb_typeof(section->'id') is distinct from 'string' or length(section->>'id')>64 or section->>'id' !~ '^[a-z][a-z0-9]*(-[a-z0-9]+)*$'
        or section->>'id'=any(ids) or not public.studio_site_text(section->'heading',160) then return false; end if;
      if section->>'type'='hero' and cardinality(ids)>0 then return false; end if;
      ids:=array_append(ids,section->>'id'); visual:=section->'visual';
      if not public.studio_site_keys(visual,array['alignment','width','spacing','surface'],array['alignment','width','spacing','surface'])
        or coalesce(visual->>'alignment','') not in ('left','center') or coalesce(visual->>'width','') not in ('contained','wide')
        or coalesce(visual->>'spacing','') not in ('compact','comfortable','generous') or coalesce(visual->>'surface','') not in ('base','muted','primary') then return false; end if;
      case section->>'type'
        when 'hero' then keys:=array['id','type','heading','visual','eyebrow','body','buttons'];required:=array['id','type','heading','visual','body','buttons'];
          if not public.studio_site_text(section->'body',2000) or (section ? 'eyebrow' and not public.studio_site_text(section->'eyebrow',80)) then return false; end if;
        when 'text' then keys:=array['id','type','heading','visual','paragraphs'];required:=keys;
          if jsonb_typeof(section->'paragraphs') is distinct from 'array' then return false; end if;
          if jsonb_array_length(section->'paragraphs') not between 1 and 8 then return false; end if;
          for raw in select value from jsonb_array_elements(section->'paragraphs') loop if not public.studio_site_text(raw,2000) then return false; end if; end loop;
        when 'cards' then keys:=array['id','type','heading','visual','intro','columns','items'];required:=array['id','type','heading','visual','columns','items'];
          if coalesce(section->>'columns','') not in ('two','three','four') or (section ? 'intro' and not public.studio_site_text(section->'intro',1000)) or jsonb_typeof(section->'items') is distinct from 'array' then return false; end if;
          if jsonb_array_length(section->'items') not between 1 and 12 then return false; end if;
          for item in select value from jsonb_array_elements(section->'items') loop
            if not public.studio_site_keys(item,array['title','body'],array['title','body']) or not public.studio_site_text(item->'title',100) or not public.studio_site_text(item->'body',1000) then return false; end if;
          end loop;
        when 'cta','contact' then keys:=array['id','type','heading','visual','body','buttons'];required:=array['id','type','heading','visual','buttons'];
          if section ? 'body' and not public.studio_site_text(section->'body',1000) then return false; end if;
        else return false;
      end case;
      if not public.studio_site_keys(section,keys,required) then return false; end if;
      if section->>'type' in ('hero','cta','contact') then
        if jsonb_typeof(section->'buttons') is distinct from 'array' then return false; end if;
        if jsonb_array_length(section->'buttons')>(case when section->>'type'='contact' then 4 else 2 end) or (section->>'type'<>'hero' and jsonb_array_length(section->'buttons')=0) then return false; end if;
        for button in select value from jsonb_array_elements(section->'buttons') loop
          if not public.studio_site_keys(button,array['label','href','appearance'],array['label','href','appearance']) or not public.studio_site_text(button->'label',80)
            or not public.studio_site_link_valid(button->'href') or coalesce(button->>'appearance','') not in ('primary','secondary','text') then return false; end if;
        end loop;
      end if;
    end loop;
  end loop;
  if not '/'=any(paths) then return false; end if;
  for page in select value from jsonb_array_elements(pages) loop
    for section in select value from jsonb_array_elements(page->'sections') loop
      for button in select value from jsonb_array_elements(coalesce(section->'buttons','[]'::jsonb)) loop
        href:=button->>'href';
        if left(href,1) in ('#','/') then
          target_path:=case when left(href,1)='#' then page->>'path' else split_part(href,'#',1) end;
          anchor:=case when position('#' in href)>0 then split_part(href,'#',2) else null end;
          select value into target from jsonb_array_elements(pages) where value->>'path'=target_path;
          if target is null or (anchor is not null and not exists(select 1 from jsonb_array_elements(target->'sections') where value->>'id'=anchor)) then return false; end if;
        end if;
      end loop;
    end loop;
  end loop;
  return octet_length(public.studio_site_json_compact(p))<=131072;
end;$$;

create table public.studio_sites (
  id uuid primary key default gen_random_uuid(), owner_id uuid not null, project_id uuid not null,
  head_version_id uuid, created_at timestamptz not null default clock_timestamp(),
  unique(owner_id,project_id), unique(owner_id,project_id,id),
  foreign key(owner_id,project_id) references public.studio_projects(owner_id,id) on delete restrict
);
create table public.studio_generation_jobs (
  id uuid primary key default gen_random_uuid(), owner_id uuid not null, project_id uuid not null, site_id uuid not null,
  request_id uuid not null, brief_version_id uuid not null, brief_hash text not null,
  project_mode text not null check(project_mode in ('opportunity','demo')),
  public_information jsonb not null check(jsonb_typeof(public_information)='object' and octet_length(public_information::text)<=131072),
  base_version_id uuid,
  status text not null default 'pending' check(status in ('pending','processing','completed','failed')),
  attempt_id uuid, error_code text check(error_code in ('cancelled','timeout','provider_unavailable','invalid_response','brief_changed','internal_error')),
  created_at timestamptz not null default clock_timestamp(), started_at timestamptz, finished_at timestamptz,
  unique(owner_id,project_id,request_id), unique(owner_id,project_id,site_id,id,brief_version_id,brief_hash),
  foreign key(owner_id,project_id,site_id) references public.studio_sites(owner_id,project_id,id) on delete restrict,
  foreign key(owner_id,project_id,brief_version_id,brief_hash) references public.studio_brief_versions(owner_id,project_id,id,content_hash) on delete restrict,
  foreign key(brief_version_id) references public.studio_brief_approvals(version_id) on delete restrict,
  check((status='pending' and attempt_id is null and started_at is null and finished_at is null and error_code is null)
    or(status='processing' and attempt_id is not null and started_at is not null and finished_at is null and error_code is null)
    or(status='completed' and attempt_id is not null and started_at is not null and finished_at is not null and error_code is null)
    or(status='failed' and finished_at is not null and error_code is not null and ((attempt_id is null and started_at is null)or(attempt_id is not null and started_at is not null))))
);
create unique index studio_generation_one_active on public.studio_generation_jobs(owner_id,project_id) where status in ('pending','processing');
create index studio_generation_jobs_owner_time on public.studio_generation_jobs(owner_id,created_at desc,id);
create table public.studio_site_versions (
  id uuid primary key default gen_random_uuid(), owner_id uuid not null, project_id uuid not null, site_id uuid not null,
  job_id uuid not null unique, brief_version_id uuid not null, brief_hash text not null,
  number integer not null check(number>0), parent_id uuid,
  document jsonb not null check(public.studio_site_document_valid(document)),
  document_hash text not null check(document_hash=public.studio_brief_hash(document)),
  created_by uuid not null check(created_by=owner_id), created_at timestamptz not null default clock_timestamp(),
  unique(site_id,number), unique(owner_id,project_id,site_id,id), unique(owner_id,project_id,site_id,id,document_hash),
  foreign key(owner_id,project_id,site_id,job_id,brief_version_id,brief_hash)
    references public.studio_generation_jobs(owner_id,project_id,site_id,id,brief_version_id,brief_hash) on delete restrict,
  foreign key(owner_id,project_id,site_id,parent_id) references public.studio_site_versions(owner_id,project_id,site_id,id) on delete restrict
);
alter table public.studio_sites add constraint studio_site_head_fk foreign key(owner_id,project_id,id,head_version_id)
  references public.studio_site_versions(owner_id,project_id,site_id,id) on delete restrict;
alter table public.studio_generation_jobs add constraint studio_generation_base_fk foreign key(owner_id,project_id,site_id,base_version_id)
  references public.studio_site_versions(owner_id,project_id,site_id,id) on delete restrict;
create table public.studio_site_reviews (
  id uuid primary key default gen_random_uuid(), owner_id uuid not null, project_id uuid not null, site_id uuid not null,
  version_id uuid not null, document_hash text not null, request_id uuid not null,
  decision text not null check(decision in ('approved','changes_requested')),
  notes text not null default '' check(length(notes)<=1000 and notes !~ '[\x01-\x08\x0B\x0C\x0E-\x1F\x7F]'),
  actor_id uuid not null check(actor_id=owner_id), created_at timestamptz not null default clock_timestamp(),
  unique(owner_id,project_id,request_id),
  foreign key(owner_id,project_id,site_id,version_id,document_hash)
    references public.studio_site_versions(owner_id,project_id,site_id,id,document_hash) on delete restrict
);
create index studio_site_versions_number on public.studio_site_versions(site_id,number desc);
create index studio_site_reviews_version_time on public.studio_site_reviews(version_id,created_at desc,id);
alter table public.studio_sites enable row level security;
alter table public.studio_generation_jobs enable row level security;
alter table public.studio_site_versions enable row level security;
alter table public.studio_site_reviews enable row level security;
create policy studio_sites_read_own on public.studio_sites for select to authenticated using(owner_id=auth.uid() and public.is_active_member() and exists(select 1 from public.studio_projects p where p.id=project_id and p.owner_id=auth.uid()));
create policy studio_jobs_read_own on public.studio_generation_jobs for select to authenticated using(owner_id=auth.uid() and public.is_active_member() and exists(select 1 from public.studio_projects p where p.id=project_id and p.owner_id=auth.uid()));
create policy studio_site_versions_read_own on public.studio_site_versions for select to authenticated using(owner_id=auth.uid() and public.is_active_member() and exists(select 1 from public.studio_projects p where p.id=project_id and p.owner_id=auth.uid()));
create policy studio_site_reviews_read_own on public.studio_site_reviews for select to authenticated using(owner_id=auth.uid() and public.is_active_member() and exists(select 1 from public.studio_projects p where p.id=project_id and p.owner_id=auth.uid()));
revoke all on public.studio_sites,public.studio_generation_jobs,public.studio_site_versions,public.studio_site_reviews from public,anon,authenticated;
grant select on public.studio_sites,public.studio_generation_jobs,public.studio_site_versions,public.studio_site_reviews to authenticated;
create trigger studio_site_versions_immutable before update or delete on public.studio_site_versions for each row execute function public.studio_deny_rewrite();
create trigger studio_site_reviews_immutable before update or delete on public.studio_site_reviews for each row execute function public.studio_deny_rewrite();

create function public.studio_generation_guard_job() returns trigger language plpgsql set search_path='' as $$
begin
  if tg_op='DELETE' or (to_jsonb(new)-array['status','attempt_id','error_code','started_at','finished_at']) is distinct from
    (to_jsonb(old)-array['status','attempt_id','error_code','started_at','finished_at']) then raise exception 'Immutable job provenance' using errcode='22023'; end if;
  if not ((old.status='pending' and new.status in ('processing','failed')) or (old.status='processing' and new.status in ('completed','failed'))) then
    raise exception 'Invalid job transition' using errcode='22023'; end if;
  if old.status='processing' and (new.attempt_id is distinct from old.attempt_id or new.started_at is distinct from old.started_at) then raise exception 'Immutable processing attempt' using errcode='22023'; end if;
  return new;
end;$$;
create trigger studio_generation_guard before update or delete on public.studio_generation_jobs for each row execute function public.studio_generation_guard_job();

-- Private helper: all job mutations take locks in PROJECT -> JOB -> SITE order.
create function public.studio_generation_lock_job(p_id uuid) returns public.studio_generation_jobs
language plpgsql security invoker set search_path='' as $$
declare actor uuid:=auth.uid(); job public.studio_generation_jobs; project uuid;
begin
  if actor is null or not public.is_active_member() then raise exception 'Forbidden' using errcode='42501'; end if;
  select * into job from public.studio_generation_jobs where id=p_id and owner_id=actor;
  if job.id is null then raise exception 'Unavailable job' using errcode='42501'; end if;
  select id into project from public.studio_projects where id=job.project_id and owner_id=actor for update;
  select * into job from public.studio_generation_jobs where id=p_id and owner_id=actor for update;
  if project is null or not public.is_active_member() then raise exception 'Forbidden' using errcode='42501'; end if;
  return job;
end;$$;

create function public.studio_create_generation_job(p_project_id uuid,p_brief_version_id uuid,p_brief_hash text,p_request_id uuid) returns public.studio_generation_jobs
language plpgsql security definer set search_path='' as $$
declare actor uuid:=auth.uid(); project public.studio_projects; brief public.studio_brief_versions; job public.studio_generation_jobs; site public.studio_sites; public_fields jsonb:='{}'; k text; f jsonb;
begin
  if actor is null or not public.is_active_member() then raise exception 'Forbidden' using errcode='42501'; end if;
  select * into project from public.studio_projects where id=p_project_id and owner_id=actor for update;
  if project.id is null or not public.is_active_member() then raise exception 'Unavailable project' using errcode='42501'; end if;
  if p_request_id is null or p_brief_version_id is null or p_brief_hash is null or p_brief_hash !~ '^[a-f0-9]{64}$' then raise exception 'Invalid request' using errcode='22023'; end if;
  select * into job from public.studio_generation_jobs where owner_id=actor and project_id=p_project_id and request_id=p_request_id;
  if job.id is not null then
    if job.brief_version_id<>p_brief_version_id or job.brief_hash<>p_brief_hash then raise exception 'Request reused with different input' using errcode='22023'; end if;
    return job;
  end if;
  if project.head_id<>p_brief_version_id then raise exception 'Briefing changed' using errcode='40001'; end if;
  select v.* into brief from public.studio_brief_versions v join public.studio_brief_approvals a on a.version_id=v.id and a.project_id=v.project_id and a.owner_id=v.owner_id and a.content_hash=v.content_hash and a.actor_id=actor
    where v.id=p_brief_version_id and v.project_id=p_project_id and v.owner_id=actor and v.content_hash=p_brief_hash;
  if brief.id is null then raise exception 'Unapproved briefing or hash mismatch' using errcode='22023'; end if;
  if not public.studio_valid_fields(brief.fields,project.mode) then raise exception 'Invalid briefing' using errcode='22023'; end if;
  for k,f in select key,value from jsonb_each(brief.fields) loop
    if f->>'verification'<>'pending' and (public.studio_site_trim(f->>'value')='' or public.studio_site_trim(f->>'source')='') then raise exception 'Invalid briefing' using errcode='22023'; end if;
    if k<>'creative_notes' and (f->>'public_use')::boolean and public.studio_site_trim(f->>'value')<>'' and public.studio_site_trim(f->>'source')<>''
      and (f->>'verification'='verified' or (project.mode='demo' and f->>'verification'='fictional')) then public_fields:=public_fields||jsonb_build_object(k,f->>'value'); end if;
  end loop;
  foreach k in array array['company','sector','city','services','audience'] loop
    if not public_fields ? k then raise exception 'Insufficient public information' using errcode='22023'; end if;
  end loop;
  if exists(select 1 from public.studio_generation_jobs where owner_id=actor and project_id=p_project_id and status in ('pending','processing')) then raise exception 'Active job already exists' using errcode='40001'; end if;
  insert into public.studio_sites(owner_id,project_id) values(actor,p_project_id) on conflict(owner_id,project_id) do nothing;
  select * into site from public.studio_sites where owner_id=actor and project_id=p_project_id;
  insert into public.studio_generation_jobs(owner_id,project_id,site_id,request_id,brief_version_id,brief_hash,project_mode,public_information,base_version_id)
    values(actor,p_project_id,site.id,p_request_id,brief.id,brief.content_hash,project.mode,public_fields,site.head_version_id) returning * into job;
  return job;
end;$$;

create function public.studio_start_generation_job(p_job_id uuid,p_attempt_id uuid) returns public.studio_generation_jobs
language plpgsql security definer set search_path='' as $$
declare job public.studio_generation_jobs; head uuid;
begin
  job:=public.studio_generation_lock_job(p_job_id);
  if p_attempt_id is null then raise exception 'Invalid attempt' using errcode='22023'; end if;
  if job.status='processing' and job.attempt_id=p_attempt_id then return job; end if;
  if job.status<>'pending' then raise exception 'Job is not pending' using errcode='40001'; end if;
  select head_id into head from public.studio_projects where id=job.project_id and owner_id=auth.uid();
  if head<>job.brief_version_id then raise exception 'Briefing changed before processing' using errcode='40001'; end if;
  update public.studio_generation_jobs set status='processing',attempt_id=p_attempt_id,started_at=clock_timestamp() where id=job.id returning * into job;
  return job;
end;$$;
create function public.studio_complete_generation_job(p_job_id uuid,p_attempt_id uuid,p_document jsonb) returns public.studio_site_versions
language plpgsql security definer set search_path='' as $$
declare job public.studio_generation_jobs; site public.studio_sites; version public.studio_site_versions; next_number integer; hash text;
begin
  job:=public.studio_generation_lock_job(p_job_id);
  if p_attempt_id is null or job.attempt_id is distinct from p_attempt_id then raise exception 'Stale attempt' using errcode='40001'; end if;
  if not public.studio_site_document_valid(p_document) or public.studio_site_trim(p_document->'identity'->>'business_name')<>public.studio_site_trim(job.public_information->>'company') then raise exception 'Invalid site document' using errcode='22023'; end if;
  hash:=public.studio_brief_hash(p_document);
  if job.status='completed' then
    select * into version from public.studio_site_versions where job_id=job.id and owner_id=auth.uid();
    if version.id is null or version.document_hash<>hash then raise exception 'Completion payload changed' using errcode='22023'; end if;
    return version;
  end if;
  if job.status<>'processing' then raise exception 'Job is not processing' using errcode='40001'; end if;
  select * into site from public.studio_sites where id=job.site_id and owner_id=auth.uid() for update;
  if site.head_version_id is distinct from job.base_version_id then raise exception 'Site head changed' using errcode='40001'; end if;
  select coalesce(max(number),0)+1 into next_number from public.studio_site_versions where site_id=site.id and owner_id=auth.uid();
  insert into public.studio_site_versions(owner_id,project_id,site_id,job_id,brief_version_id,brief_hash,number,parent_id,document,document_hash,created_by)
    values(auth.uid(),job.project_id,site.id,job.id,job.brief_version_id,job.brief_hash,next_number,site.head_version_id,p_document,hash,auth.uid()) returning * into version;
  update public.studio_sites set head_version_id=version.id where id=site.id and owner_id=auth.uid();
  update public.studio_generation_jobs set status='completed',finished_at=clock_timestamp() where id=job.id;
  return version;
end;$$;
create function public.studio_fail_generation_job(p_job_id uuid,p_attempt_id uuid,p_error_code text) returns public.studio_generation_jobs
language plpgsql security definer set search_path='' as $$
declare job public.studio_generation_jobs;
begin
  job:=public.studio_generation_lock_job(p_job_id);
  if p_error_code is null or p_error_code not in ('cancelled','timeout','provider_unavailable','invalid_response','brief_changed','internal_error') then raise exception 'Invalid error code' using errcode='22023'; end if;
  if job.attempt_id is distinct from p_attempt_id then raise exception 'Stale attempt' using errcode='40001'; end if;
  if job.status='failed' and job.error_code=p_error_code then return job; end if;
  if job.status not in ('pending','processing') then raise exception 'Job is terminal' using errcode='40001'; end if;
  update public.studio_generation_jobs set status='failed',error_code=p_error_code,finished_at=clock_timestamp() where id=job.id returning * into job;
  return job;
end;$$;
create function public.studio_review_site_version(p_version_id uuid,p_document_hash text,p_decision text,p_notes text,p_request_id uuid) returns public.studio_site_reviews
language plpgsql security definer set search_path='' as $$
declare actor uuid:=auth.uid(); version public.studio_site_versions; review public.studio_site_reviews; site public.studio_sites; brief_head uuid;
begin
  if actor is null or not public.is_active_member() then raise exception 'Forbidden' using errcode='42501'; end if;
  select * into version from public.studio_site_versions where id=p_version_id and owner_id=actor;
  if version.id is null then raise exception 'Unavailable version' using errcode='42501'; end if;
  select head_id into brief_head from public.studio_projects where id=version.project_id and owner_id=actor for update;
  if brief_head is null or not public.is_active_member() then raise exception 'Forbidden' using errcode='42501'; end if;
  if p_request_id is null or p_document_hash is null or p_decision is null or p_decision not in ('approved','changes_requested') or p_notes is null or length(p_notes)>1000 or p_notes ~ '[\x01-\x08\x0B\x0C\x0E-\x1F\x7F]' then raise exception 'Invalid review' using errcode='22023'; end if;
  select * into review from public.studio_site_reviews where owner_id=actor and project_id=version.project_id and request_id=p_request_id;
  if review.id is not null then
    if review.version_id<>version.id or review.document_hash<>p_document_hash or review.decision<>p_decision or review.notes<>p_notes then raise exception 'Review request reused' using errcode='22023'; end if;
    return review;
  end if;
  select * into site from public.studio_sites where id=version.site_id and owner_id=actor for update;
  if p_document_hash<>version.document_hash or site.head_version_id is distinct from version.id or (p_decision='approved' and brief_head<>version.brief_version_id) then raise exception 'Version or briefing changed' using errcode='40001'; end if;
  insert into public.studio_site_reviews(owner_id,project_id,site_id,version_id,document_hash,request_id,decision,notes,actor_id)
    values(actor,version.project_id,site.id,version.id,version.document_hash,p_request_id,p_decision,p_notes,actor) returning * into review;
  return review;
end;$$;

revoke all on function public.studio_site_trim(text),public.studio_site_keys(jsonb,text[],text[]),public.studio_site_text(jsonb,integer),public.studio_site_json_compact(jsonb),
  public.studio_site_link_valid(jsonb),public.studio_site_document_valid(jsonb),public.studio_generation_guard_job(),public.studio_generation_lock_job(uuid),
  public.studio_create_generation_job(uuid,uuid,text,uuid),public.studio_start_generation_job(uuid,uuid),public.studio_complete_generation_job(uuid,uuid,jsonb),
  public.studio_fail_generation_job(uuid,uuid,text),public.studio_review_site_version(uuid,text,text,text,uuid) from public,anon,authenticated;
grant execute on function public.studio_create_generation_job(uuid,uuid,text,uuid),public.studio_start_generation_job(uuid,uuid),public.studio_complete_generation_job(uuid,uuid,jsonb),
  public.studio_fail_generation_job(uuid,uuid,text),public.studio_review_site_version(uuid,text,text,text,uuid) to authenticated;
commit;
