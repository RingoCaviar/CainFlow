# Let themes provide semantics and features own component skins

CainFlow themes will provide semantic visual roles, while each feature owns the selectors and state styling for its UI. A theme must not need to understand a feature's DOM structure merely to supply its palette. This seam gives feature styling one authoritative location and lets a theme express visual intent through stable meanings such as surfaces, text, borders, accents, focus, danger, and interaction states.

Feature-specific theme exceptions are disallowed by default. An exception is acceptable only when a distinctive theme effect cannot be expressed through the shared semantic roles; it must remain localized, explain why the shared skin is insufficient, and have targeted visual coverage. The semantic role catalog may evolve as component families are migrated, so this decision deliberately does not freeze a permanent token list.

Migration follows an expand-contract sequence per component family. CainFlow first adds semantic roles and a shared feature skin, verifies every supported theme at the rendered behavior seam, and then removes the corresponding legacy theme-qualified selectors and temporary fallbacks. The settings panel is the first migration pilot; later component families reuse the same architectural seam rather than creating parallel theme interfaces.
