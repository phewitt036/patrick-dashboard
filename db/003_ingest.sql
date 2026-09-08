-- Ingest: let another system push records in without double-counting them.
--
-- Pixit reads a screenshot and pushes what it found. Screenshots get retried -
-- a timeout, a tap that did not look like it worked, a phone that reconnected
-- and resent - and Salesforce had nothing to stop the same delivery being
-- written twice. Two $7.25 orders in one day are also perfectly real, so the
-- row contents cannot be the test. The pushing system supplies its own stable
-- id for the thing it extracted, and that is what has to be unique.
--
-- Nullable: everything entered by hand has no external id, and Postgres treats
-- each NULL as distinct, so a plain unique constraint leaves manual entry alone.

begin;

alter table income_record  add column if not exists external_id text;
alter table expense_record add column if not exists external_id text;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'income_record_external_id_key') then
    alter table income_record add constraint income_record_external_id_key unique (external_id);
  end if;
  if not exists (select 1 from pg_constraint where conname = 'expense_record_external_id_key') then
    alter table expense_record add constraint expense_record_external_id_key unique (external_id);
  end if;
end $$;

comment on column income_record.external_id is
  'Stable id from whatever system pushed this row. Null for anything entered by hand. Unique, so a retried push updates nothing rather than duplicating.';

commit;
