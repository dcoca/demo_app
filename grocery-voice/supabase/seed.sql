-- Local development seed (runs on `supabase db reset`). Never run in production.
--
-- Two confirmed users who share one household:
--   dana@example.com / password123   (owner)
--   sam@example.com  / password123   (member)

do $$
declare
  v_dana uuid := '00000000-0000-4000-8000-00000000da1a';
  v_sam uuid := '00000000-0000-4000-8000-000000005a11';
  v_household uuid := '00000000-0000-4000-8000-0000000000e1';
  v_cycle uuid := '00000000-0000-4000-8000-0000000000c1';
  v_user record;
begin
  for v_user in
    select * from (values (v_dana, 'dana@example.com', 'Dana'), (v_sam, 'sam@example.com', 'Sam')) as t(id, email, name)
  loop
    insert into auth.users (
      instance_id, id, aud, role, email, encrypted_password, email_confirmed_at,
      raw_app_meta_data, raw_user_meta_data, created_at, updated_at,
      confirmation_token, email_change, email_change_token_new, recovery_token
    ) values (
      '00000000-0000-0000-0000-000000000000', v_user.id, 'authenticated', 'authenticated', v_user.email,
      extensions.crypt('password123', extensions.gen_salt('bf')), now(),
      '{"provider":"email","providers":["email"]}', jsonb_build_object('display_name', v_user.name), now(), now(),
      '', '', '', ''
    ) on conflict (id) do nothing;

    insert into auth.identities (id, user_id, provider_id, identity_data, provider, last_sign_in_at, created_at, updated_at)
    values (
      gen_random_uuid(), v_user.id, v_user.id::text,
      jsonb_build_object('sub', v_user.id::text, 'email', v_user.email, 'email_verified', true),
      'email', now(), now(), now()
    ) on conflict do nothing;
  end loop;

  insert into public.households (id, name, created_by) values (v_household, 'The Parkers', v_dana)
  on conflict do nothing;
  insert into public.household_members (household_id, user_id, role) values
    (v_household, v_dana, 'owner'), (v_household, v_sam, 'member')
  on conflict do nothing;
  insert into public.shopping_cycles (id, household_id, sequence) values (v_cycle, v_household, 1)
  on conflict do nothing;
  insert into public.orders (household_id, cycle_id) values (v_household, v_cycle)
  on conflict do nothing;
  insert into public.household_schedules (household_id, timezone, enabled, shopping_weekday)
  values (v_household, 'America/New_York', false, 0)
  on conflict do nothing;

  insert into public.shopping_items (household_id, cycle_id, name, normalized_name, quantity, unit, source, added_by, added_by_label)
  values
    (v_household, v_cycle, 'milk', 'milk', 2, 'gallon', 'siri', v_dana, 'Siri (Dana''s iPhone)'),
    (v_household, v_cycle, 'strawberries', 'strawberry', null, null, 'alexa', v_sam, 'Alexa (via Home Assistant)'),
    (v_household, v_cycle, 'sourdough bread', 'sourdough bread', 1, 'loaf', 'web', v_sam, null);
end;
$$;
