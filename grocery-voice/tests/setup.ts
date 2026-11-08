// Deterministic defaults so modules that read env at import time are testable.
process.env.NEXT_PUBLIC_SUPABASE_URL ??= "http://127.0.0.1:54321";
process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY ??= "test-publishable-key";
process.env.NEXT_PUBLIC_APP_URL ??= "http://localhost:3000";
process.env.SUPABASE_SERVICE_ROLE_KEY ??= "test-service-role-key";
process.env.CRON_SECRET ??= "test-cron-secret-test-cron-secret";
process.env.INTEGRATION_ENCRYPTION_KEY ??= Buffer.alloc(32, 7).toString("base64");
