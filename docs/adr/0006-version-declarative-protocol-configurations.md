# Version declarative protocol configurations

CainFlow persists a Protocol schema version with every user-owned Declarative protocol configuration, including a stable-ID override for a Built-in protocol. Supported older versions pass through one load-time migration path. An override tied to a newer unknown baseline remains preserved and read-only rather than being guessed at, edited destructively, or executed; resetting the override removes only the user-owned layer and reveals the current Built-in baseline.
