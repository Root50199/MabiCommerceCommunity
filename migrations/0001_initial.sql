CREATE TABLE installations (
    id TEXT PRIMARY KEY,
    token_hash TEXT NOT NULL UNIQUE,
    consent_version TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    revoked_at INTEGER
);

CREATE TABLE scan_tickets (
    id TEXT PRIMARY KEY,
    installation_id TEXT NOT NULL REFERENCES installations(id),
    expires_at INTEGER NOT NULL
);
CREATE INDEX scan_tickets_expiry ON scan_tickets(expires_at);

CREATE TABLE scans (
    sequence INTEGER PRIMARY KEY AUTOINCREMENT,
    id TEXT NOT NULL UNIQUE,
    installation_id TEXT NOT NULL REFERENCES installations(id),
    received_at INTEGER NOT NULL,
    payload_hash TEXT NOT NULL,
    mode TEXT NOT NULL CHECK (mode IN ('trade', 'group', 'barter')),
    product_id INTEGER NOT NULL,
    source_post_id INTEGER NOT NULL,
    source_price INTEGER NOT NULL CHECK (source_price > 0),
    stock INTEGER NOT NULL CHECK (stock >= 0)
);
CREATE INDEX scans_product_sequence ON scans(mode, product_id, sequence);
CREATE INDEX scans_installation ON scans(installation_id);
CREATE INDEX scans_received ON scans(received_at);

CREATE TABLE quotes (
    scan_sequence INTEGER NOT NULL REFERENCES scans(sequence),
    post_id INTEGER NOT NULL,
    sale_price INTEGER NOT NULL CHECK (sale_price >= 0),
    profit INTEGER NOT NULL,
    PRIMARY KEY (scan_sequence, post_id)
);

CREATE TABLE private_ip_logs (
    id INTEGER PRIMARY KEY,
    scan_sequence INTEGER UNIQUE REFERENCES scans(sequence),
    installation_id TEXT NOT NULL REFERENCES installations(id),
    received_at INTEGER NOT NULL,
    ip TEXT NOT NULL,
    action TEXT NOT NULL CHECK (action IN ('register', 'scan'))
);
CREATE INDEX private_ip_logs_retention ON private_ip_logs(received_at);

CREATE TABLE rate_limits (
    key TEXT PRIMARY KEY,
    count INTEGER NOT NULL,
    expires_at INTEGER NOT NULL
);
CREATE INDEX rate_limits_expiry ON rate_limits(expires_at);

CREATE TABLE moderation (
    singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
    revision INTEGER NOT NULL
);
INSERT INTO moderation(singleton, revision) VALUES (1, 0);
