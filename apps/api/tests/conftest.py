import os
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

# app.main calls sys.exit(1) at import if any of these is unset, which made
# pytest unable to even collect tests without real secrets. Placeholders are
# enough: tests that touch Postgres, Supabase or Groq replace those clients
# with fakes. setdefault, so a real value already in the environment wins.
for _name, _value in {
    "DATABASE_URL": "postgresql://test:test@127.0.0.1:5432/test",
    "GROQ_API_KEY": "test-groq-key",
    "RESEND_API_KEY": "re_test_key",
    "SUPABASE_URL": "https://placeholder.supabase.co",
    "SUPABASE_SERVICE_ROLE_KEY": "test-service-role-key",
    "SUPABASE_STORAGE_BUCKET": "test-bucket",
}.items():
    os.environ.setdefault(_name, _value)
