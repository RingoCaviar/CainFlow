# Version declarative protocol configurations

CainFlow will persist a Protocol schema version with every user-owned Declarative protocol configuration and upgrade supported older versions through one load-time migration path. Configurations from a newer unknown version remain preserved and read-only rather than being guessed at, edited destructively, or executed; this makes imported protocol configurations a durable user-owned format as the editor gains new capabilities.
