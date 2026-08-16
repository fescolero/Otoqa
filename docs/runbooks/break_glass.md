# Runbook — break-glass (console or staff IdP unavailable)

**When to use this.** The console won't load, sign-in fails for everyone, or the
staff identity provider is down. This is the documented fallback; there is
deliberately no bypass built into the console.

**Diagnose the layer first**

| Symptom | Layer | Action |
| --- | --- | --- |
| Access-denied screen naming the issuer | staff IdP config | Compare `STAFF_ISSUER` on the Convex deployment with the WorkOS staff project. The denial screen prints the token's actual issuer — it is a complete diagnosis. |
| "Not platform staff (email is not on STAFF_EMAIL_ALLOWLIST)" | allowlist | Add the email to `STAFF_EMAIL_ALLOWLIST` on the Convex deployment. |
| "Platform console is not enabled on this deployment" | env missing | `STAFF_ISSUER` is unset on that deployment. |
| Sign-in loops / IdP errors | WorkOS staff project | Check WorkOS status. No local fix. |
| Console loads, every panel errors | Convex deploy lag | The console deployed ahead of the backend. Run `npx convex deploy`. |

**Fallback while the console is unavailable**

The Convex dashboard remains the manual path for reads and for running internal
functions. It is deliberately outside the console's auth, and it is the reason
we do not build an emergency bypass.

⚠️ Actions taken from the Convex dashboard **do not write `platformAuditLog`**.
Anything done this way must be recorded afterwards: file a ticket in the console
describing what was changed, by whom, and why, once access is restored.

**Who has dashboard access**

<!-- Fill in: named holders of Convex dashboard production access. Review this
list quarterly alongside STAFF_EMAIL_ALLOWLIST. -->

**After the incident**

1. Record any dashboard-performed actions as tickets (above).
2. If the cause was configuration, note which env var and on which deployment.
3. If sign-in was down for more than an hour, review whether a second
   allowlisted account on a different IdP account would have helped.
