# Share generated media through locally managed Media assets

CainFlow persists every generated image and video as a content-addressed Media asset, then stores durable references from generation nodes and history records instead of storing independent media copies. A Media asset survives while at least one reference remains; deleting a node, workflow, history entry, or an automatically expired history entry only removes that owner's reference.

CainFlow reads a local Media asset before using any retained provider URL. A missing cached legacy video is a recoverable state, never a silent remote fallback: the user explicitly confirms Media asset recovery, observes progress and terminal state, and may cancel or retry. If cache capacity is exhausted and no unreferenced Media asset can be reclaimed, CainFlow retains the remote result URL and reports that it was not cached.

The storage backend owns the persistent reference index, cache quota, cleanup, and startup repair. The settings surface exposes actual cache use, the quota, and safe cleanup of unreferenced Media assets. This decision is separate from ADR-0003: media history is a user-facing result reference, not a Bounded diagnostic record.
