-- Leaderboard for Ten Seconds (applied to the Supabase project "ten-seconds").
-- The table is not reachable directly: RLS is on with no policies and grants are revoked.
-- Clients go through two SECURITY DEFINER functions that validate every input.

create table public.results (
  client_id   uuid primary key,
  player_id   uuid not null,
  name        text not null check (char_length(name) between 2 and 16),
  elapsed_ms  double precision not null check (elapsed_ms > 0 and elapsed_ms <= 30000),
  abs_delta_ms double precision not null,
  perfect     boolean not null,
  played_at   timestamptz not null,
  received_at timestamptz not null default now(),
  offline     boolean not null default false
);
create index results_player_best on public.results (player_id, abs_delta_ms, received_at);
create index results_player_recent on public.results (player_id, received_at desc);

alter table public.results enable row level security;
revoke all on public.results from anon, authenticated;

-- Best result per player, ranked by distance from 10 000 ms, then earliest.
create or replace view public.standings with (security_invoker = true) as
  select *, row_number() over (order by abs_delta_ms, received_at) as rank
  from (
    select distinct on (player_id) *
    from public.results
    order by player_id, abs_delta_ms, received_at
  ) b;
revoke all on public.standings from anon, authenticated;

create or replace function public.submit_result(
  p_client_id uuid, p_player_id uuid, p_name text, p_elapsed_ms double precision, p_played_at bigint
) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_name text := upper(regexp_replace(btrim(coalesce(p_name, '')), '\s+', ' ', 'g'));
  v_now  timestamptz := now();
  v_played timestamptz;
  v_prev double precision;
  v_row results%rowtype;
  v_abs double precision;
  v_rank bigint;
begin
  if p_client_id is null or p_player_id is null then return jsonb_build_object('status', 422, 'error', 'Invalid id'); end if;
  if v_name !~ '^[[:alnum:] _.-]{2,16}$' then return jsonb_build_object('status', 422, 'error', 'Invalid name'); end if;
  if p_elapsed_ms is null or p_elapsed_ms <= 0 or p_elapsed_ms > 30000 or p_elapsed_ms = 'NaN'::float8 then
    return jsonb_build_object('status', 422, 'error', 'Invalid time'); end if;
  if p_played_at is null then return jsonb_build_object('status', 422, 'error', 'Invalid playedAt'); end if;
  v_played := to_timestamp(p_played_at / 1000.0);
  if v_played > v_now + interval '5 minutes' then return jsonb_build_object('status', 422, 'error', 'playedAt is in the future'); end if;
  if v_played < v_now - interval '30 days' then return jsonb_build_object('status', 422, 'error', 'Result is too old'); end if;

  -- Idempotent: a retried submission returns the original outcome.
  select * into v_row from results where client_id = p_client_id;
  if found then
    select rank into v_rank from standings where player_id = v_row.player_id;
    return jsonb_build_object('status', 200, 'ok', true, 'duplicate', true, 'id', v_row.client_id, 'rank', v_rank, 'perfect', v_row.perfect);
  end if;

  if (select count(*) from results where player_id = p_player_id and received_at > v_now - interval '1 minute') >= 60 then
    return jsonb_build_object('status', 429, 'error', 'Too many submissions, slow down');
  end if;

  select min(abs_delta_ms) into v_prev from results where player_id = p_player_id;
  -- The verdict is re-derived from the raw elapsed time; clients never claim "perfect".
  v_abs := abs(p_elapsed_ms - 10000);
  insert into results (client_id, player_id, name, elapsed_ms, abs_delta_ms, perfect, played_at, received_at, offline)
  values (p_client_id, p_player_id, v_name, round(p_elapsed_ms::numeric, 4)::float8, v_abs, v_abs < 0.5, v_played, v_now,
          v_now - v_played > interval '1 minute')
  on conflict (client_id) do nothing;
  update results set name = v_name where player_id = p_player_id and name <> v_name;

  select rank into v_rank from standings where player_id = p_player_id;
  return jsonb_build_object('status', 201, 'ok', true, 'id', p_client_id, 'perfect', v_abs < 0.5,
    'rank', v_rank, 'personalBest', v_prev is null or v_abs < v_prev);
end $$;

create or replace function public.get_leaderboard(p_limit int default 50, p_player uuid default null)
returns jsonb
language sql stable security definer set search_path = public as $$
  with s as (select * from standings),
  lim as (select least(greatest(coalesce(p_limit, 50), 1), 100) as n)
  select jsonb_build_object(
    'target', 10000,
    'total', (select count(*) from s),
    'entries', coalesce((
      select jsonb_agg(jsonb_build_object(
        'rank', rank, 'name', name, 'elapsedMs', elapsed_ms, 'deltaMs', elapsed_ms - 10000,
        'perfect', perfect, 'playedAt', (extract(epoch from played_at) * 1000)::bigint,
        'me', p_player is not null and player_id = p_player) order by rank)
      from s where rank <= (select n from lim)), '[]'::jsonb),
    'you', (
      select jsonb_build_object('rank', rank, 'name', name, 'elapsedMs', elapsed_ms, 'deltaMs', elapsed_ms - 10000,
        'perfect', perfect, 'me', true)
      from s where p_player is not null and player_id = p_player and rank > (select n from lim))
  );
$$;

revoke all on function public.submit_result(uuid, uuid, text, double precision, bigint) from public, authenticated;
revoke all on function public.get_leaderboard(int, uuid) from public, authenticated;
grant execute on function public.submit_result(uuid, uuid, text, double precision, bigint) to anon;
grant execute on function public.get_leaderboard(int, uuid) to anon;
