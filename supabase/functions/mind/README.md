# mind — capture endpoint

Deployed to Supabase project `bxfyqkqwyyqfxsibywtg` as the function `mind`
(`verify_jwt: false` — the function does its own auth, either `x-mind-secret`
for the iOS Shortcut or an owner JWT for the browse page).

This file is the source of truth. Deploy it with:

    TOK=$(security find-generic-password -s "Supabase CLI" -w)
    curl -X POST "https://api.supabase.com/v1/projects/bxfyqkqwyyqfxsibywtg/functions/deploy?slug=mind" \
      -H "authorization: Bearer $TOK" \
      -F 'metadata={"entrypoint_path":"index.ts","name":"mind","verify_jwt":false};type=application/json' \
      -F "file=@supabase/functions/mind/index.ts;type=application/typescript;filename=index.ts"

Secrets it expects, set in the Supabase dashboard, never here:
`ANTHROPIC_API_KEY`, `MIND_SECRET` (plus the SUPABASE_* pair the runtime injects).
