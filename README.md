# boxboxbox
Storrrage, my storage app

## Deploying account deletion

The account deletion action requires the `delete-account` Supabase Edge Function in `supabase/functions/delete-account/index.ts`. It uses the project’s built-in `SUPABASE_URL`, `SUPABASE_ANON_KEY`, and `SUPABASE_SERVICE_ROLE_KEY` secrets; never put the service-role key in the app or share it.

The easiest deployment is in the Supabase Dashboard: open **Edge Functions**, create a function named `delete-account`, paste in `supabase/functions/delete-account/index.ts`, and deploy it. Turn off the dashboard’s gateway JWT verification for this function; the function itself validates the caller with `auth.getUser()` and needs unauthenticated CORS preflights to reach its handler. Never expose the service-role key.

Alternatively, deploy from the repository root with the Supabase CLI:

```powershell
supabase login
supabase link --project-ref lqzfkhactizvzfzmigcz
supabase functions deploy delete-account
```

The function verifies the signed-in user, removes that user’s account records, keeps shared household inventory, and promotes an existing member when the deleting user owned the household. If no household members remain, its data is preserved but nobody can access it. Account deletion will fail until the function has been deployed.
