-- 015_audit_user_actions.sql

DO $$ BEGIN
    ALTER TYPE audit_action ADD VALUE IF NOT EXISTS 'USER_CREATED';
EXCEPTION WHEN duplicate_object THEN null;
END $$;

DO $$ BEGIN
    ALTER TYPE audit_action ADD VALUE IF NOT EXISTS 'USER_UPDATED';
EXCEPTION WHEN duplicate_object THEN null;
END $$;

DO $$ BEGIN
    ALTER TYPE audit_action ADD VALUE IF NOT EXISTS 'USER_PASSWORD_RESET';
EXCEPTION WHEN duplicate_object THEN null;
END $$;
