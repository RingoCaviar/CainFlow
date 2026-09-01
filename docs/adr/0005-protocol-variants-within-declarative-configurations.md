# Keep model variants within declarative protocol configurations

CainFlow will represent provider-model differences as model-ID-selected Protocol variants within one Declarative protocol configuration, rather than duplicating compatibility formats or requiring a node-level mode switch. This keeps provider behavior portable as one configuration while allowing a model's encoding, media rules, and constraints to be selected from the already-authoritative model ID; complex transport remains behind a Transport adapter.
