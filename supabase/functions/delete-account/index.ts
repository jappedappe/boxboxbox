import { createClient } from "npm:@supabase/supabase-js@2";

const allowedOrigins = new Set([
  "https://jappedappe.github.io",
  "http://localhost:8765",
  "http://127.0.0.1:8765",
]);

function response(body: Record<string, string>, status: number, origin: string | null) {
  const headers = new Headers({
    "Content-Type": "application/json",
    "Access-Control-Allow-Headers": "authorization, apikey, content-type, x-client-info",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Vary": "Origin",
  });
  if (origin && allowedOrigins.has(origin)) headers.set("Access-Control-Allow-Origin", origin);
  return new Response(status === 204 ? null : JSON.stringify(body), {status, headers});
}

Deno.serve(async req => {
  const origin = req.headers.get("Origin");
  if (origin && !allowedOrigins.has(origin)) return response({error: "origin_not_allowed"}, 403, null);
  if (req.method === "OPTIONS") return response({}, 204, origin);
  if (req.method !== "POST") return response({error: "method_not_allowed"}, 405, origin);

  const url = Deno.env.get("SUPABASE_URL");
  const anonKey = Deno.env.get("SUPABASE_ANON_KEY");
  const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  const authorization = req.headers.get("Authorization");
  if (!url || !anonKey || !serviceRoleKey) {
    console.error("Account deletion function is missing Supabase environment variables.");
    return response({error: "function_not_configured"}, 500, origin);
  }
  if (!authorization?.startsWith("Bearer ")) return response({error: "not_authenticated"}, 401, origin);

  try {
    const userClient = createClient(url, anonKey, {
      global: {headers: {Authorization: authorization}},
      auth: {autoRefreshToken: false, persistSession: false},
    });
    const {data: {user}, error: userError} = await userClient.auth.getUser();
    if (userError || !user) return response({error: "not_authenticated"}, 401, origin);

    const admin = createClient(url, serviceRoleKey, {
      auth: {autoRefreshToken: false, persistSession: false},
    });
    const userId = user.id;
    const {data: memberships, error: membershipsError} = await admin
      .from("members").select("household_id, role").eq("user_id", userId);
    if (membershipsError) throw membershipsError;
    const {data: ownedHouseholds, error: ownedError} = await admin
      .from("households").select("id").eq("created_by", userId);
    if (ownedError) throw ownedError;

    const ownedIds = new Set((ownedHouseholds || []).map(h => h.id));
    const membershipByHousehold = new Map((memberships || []).map(m => [m.household_id, m]));
    const householdIds = new Set([...ownedIds, ...membershipByHousehold.keys()]);
    for (const householdId of householdIds) {
      const {data: remaining, error: remainingError} = await admin
        .from("members").select("user_id").eq("household_id", householdId)
        .neq("user_id", userId).order("joined_at", {ascending: true}).limit(1);
      if (remainingError) throw remainingError;
      const successor = remaining?.[0]?.user_id || null;

      if (ownedIds.has(householdId)) {
        const {error} = await admin.from("households").update({created_by: successor})
          .eq("id", householdId).eq("created_by", userId);
        if (error) throw error;
      }
      if (membershipByHousehold.get(householdId)?.role === "owner" && successor) {
        const {error: ownerRemovalError} = await admin.from("members").delete()
          .eq("household_id", householdId).eq("user_id", userId);
        if (ownerRemovalError) throw ownerRemovalError;
        const {error} = await admin.from("members").update({role: "owner"})
          .eq("household_id", householdId).eq("user_id", successor);
        if (error) throw error;
      }
    }

    const {data: profile, error: profileReadError} = await admin
      .from("profiles").select("contact_email").eq("user_id", userId).maybeSingle();
    if (profileReadError) throw profileReadError;

    const {error: inviteCreatedError} = await admin.from("invites")
      .update({created_by: null, note: null}).eq("created_by", userId);
    if (inviteCreatedError) throw inviteCreatedError;
    const {error: inviteUsedError} = await admin.from("invites")
      .update({used_by: null}).eq("used_by", userId);
    if (inviteUsedError) throw inviteUsedError;
    const {error: presenceError} = await admin.from("presence").delete().eq("user_id", userId);
    if (presenceError) throw presenceError;
    const {error: profileError} = await admin.from("profiles").delete().eq("user_id", userId);
    if (profileError) throw profileError;
    const {error: adminError} = await admin.from("admins").delete().eq("user_id", userId);
    if (adminError) throw adminError;
    const {error: memberError} = await admin.from("members").delete().eq("user_id", userId);
    if (memberError) throw memberError;
    const {error: recordsError} = await admin.from("records").update({updated_by: null}).eq("updated_by", userId);
    if (recordsError) throw recordsError;

    const contactEmails = new Set([user.email, profile?.contact_email].filter((email): email is string => !!email));
    for (const email of contactEmails) {
      const {error} = await admin.from("feedback").delete().eq("contact", email);
      if (error) throw error;
    }

    const {error: deleteError} = await admin.auth.admin.deleteUser(userId);
    if (deleteError) throw deleteError;
    return response({ok: "true"}, 200, origin);
  } catch (error) {
    console.error("Account deletion failed.", error);
    return response({error: "account_deletion_failed"}, 500, origin);
  }
});
