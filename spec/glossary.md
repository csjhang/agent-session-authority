# Glossary

| Term | Meaning |
| --- | --- |
| SessionId | Stable work-container id (not WebSocket, not LLM conversation) |
| ActorId | Human, client, service, or agent identity |
| ControlLease | scope, holder, issuedAt, expiresAt, fenceEpoch |
| RuntimeGeneration | Monotonic/reissued generation on authority-relevant runtime start/restore |
| ActionBinding | actionType, target, canonical args, policyVersion, runtimeGeneration, nonce, expiry |
| ActionDigest | Unambiguous digest of canonical ActionBinding |
| ApprovalDecision | approver, actionDigest, decision, policy, issuedAt, expiresAt |
| FenceToken / FenceEpoch | Monotonic token effect gateway must verify |
| EffectId | Stable idempotency key for one intended effect |
| EffectReceipt | Verifiable reply from effect boundary |
| WorkSession | Long-lived shared work context |
| Observer / Contributor / Controller / Approver | Logical roles; ownership != control |
