---
name: Discord runner live-message throttle
description: Why the auto-quest runner appeared to "freeze" after LOGIN, and the rule to prevent regressing it.
---

The quest runner's live status message uses a throttle to avoid Discord edit rate limits (~1 edit per 2s). The original implementation dropped any update requested inside the throttle window instead of deferring it.

**Why:** Right after login, the code checks quests and — if there are none — logs a "no quests, recheck in 15 min" line almost immediately (within the 2s throttle window from the LOGIN message). That update got silently dropped, and the next update wasn't for 15 minutes. Users saw the bot print "LOGIN" and then appear to hang/do nothing, when it was actually working correctly in the background.

**How to apply:** Any throttled/rate-limited "send status to Discord" helper in this codebase must guarantee eventual delivery of the latest state (e.g. schedule a trailing flush for the remaining wait time) rather than dropping updates that arrive inside the window. Don't reintroduce a drop-style throttle for user-facing status messages.
