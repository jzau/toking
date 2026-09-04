CREATE OR REPLACE FUNCTION prevent_ledger_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'posted ledger records are immutable';
END;
$$;--> statement-breakpoint

CREATE TRIGGER ledger_journals_immutable
BEFORE UPDATE OR DELETE ON "ledger_journals"
FOR EACH ROW EXECUTE FUNCTION prevent_ledger_mutation();--> statement-breakpoint

CREATE TRIGGER ledger_entries_immutable
BEFORE UPDATE OR DELETE ON "ledger_entries"
FOR EACH ROW EXECUTE FUNCTION prevent_ledger_mutation();--> statement-breakpoint

CREATE OR REPLACE FUNCTION verify_ledger_journal_balance()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  affected_journal_id uuid;
  journal_total bigint;
BEGIN
  affected_journal_id := COALESCE(NEW.journal_id, OLD.journal_id);
  SELECT COALESCE(SUM(amount), 0)
    INTO journal_total
    FROM ledger_entries
   WHERE journal_id = affected_journal_id;

  IF journal_total <> 0 THEN
    RAISE EXCEPTION 'ledger journal % is not balanced: %', affected_journal_id, journal_total;
  END IF;

  RETURN NULL;
END;
$$;--> statement-breakpoint

CREATE CONSTRAINT TRIGGER ledger_journal_balanced
AFTER INSERT OR UPDATE OR DELETE ON "ledger_entries"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION verify_ledger_journal_balance();
