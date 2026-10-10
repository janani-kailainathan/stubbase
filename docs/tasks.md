# Tasks

1. Provision the 4GB CX23 and add it to the Ansible inventory, then deploy
2. Load test on the CX23, then raise MAX_ACTIVE_TENANTS and the log, SQL and MCP caps from what it shows (and decide on swap)
3. Vertex AI setup: Google Cloud project, service-account key, STUBBASE_VERTEX_* for Ansible; confirm the model id and region on the first real call
4. Measure Co-Pilot tokens per turn and set the final credit amounts and pack prices
5. Check the Co-Pilot against the real model: filters, asking before bulk changes, "that feature doesn't exist"
6. Decide whether existing Free accounts get the 100 gift credits
7. Free-cap message says "only paid plans are open" but nothing can be bought yet: point it to contact until billing exists
8. Privacy policy: say that addresses refused by the free cap are kept
9. Delete-table button in the Files rail
10. Data-model warnings on record changes: likely typos, and records left pointing at a deleted one
11. Enforce required fields (reconcile with SCHEMA_<TABLE>, and make "required" a confirmed proposal)
12. Bulk record creation beyond ~200 per call (server-side generator)
13. Update docs/plans-credits-addons.md, and decide whether to delete the half-filled Claude Doc
14. Push the branch

Later: payment gateway, 80% warning email, grace period, auto-recharge, Enterprise
