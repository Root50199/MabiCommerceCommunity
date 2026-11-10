ALTER TABLE installations ADD COLUMN expires_at INTEGER;

CREATE TABLE scans_v4 (
    sequence INTEGER PRIMARY KEY AUTOINCREMENT,
    id TEXT NOT NULL UNIQUE,
    installation_id TEXT REFERENCES installations(id),
    received_at INTEGER NOT NULL,
    payload_hash TEXT NOT NULL,
    mode TEXT NOT NULL CHECK (mode IN ('trade', 'group', 'barter')),
    product_id INTEGER NOT NULL,
    source_post_id INTEGER NOT NULL,
    source_price INTEGER,
    stock INTEGER NOT NULL CHECK (stock >= 0),
    price_basis TEXT NOT NULL DEFAULT 'legacy',
    observed_source_price INTEGER,
    purchase_discount_percent REAL,
    association_expires_at INTEGER,
    hidden INTEGER NOT NULL DEFAULT 0 CHECK (hidden IN (0, 1)),
    CHECK ((mode = 'barter' AND source_price IS NULL) OR
           (mode != 'barter' AND source_price IS NOT NULL AND source_price > 0))
);
-- Existing observation links are explicitly exempt from the new expiry policy.
INSERT INTO scans_v4 SELECT s.sequence, s.id, s.installation_id, s.received_at,
    s.payload_hash, s.mode, s.product_id, s.source_post_id, s.source_price, s.stock,
    s.price_basis, s.observed_source_price, s.purchase_discount_percent, NULL,
    CASE WHEN i.revoked_at IS NULL THEN 0 ELSE 1 END
    FROM scans s JOIN installations i ON i.id = s.installation_id;
UPDATE sqlite_sequence SET seq = MAX(seq, (SELECT seq FROM sqlite_sequence WHERE name = 'scans'))
    WHERE name = 'scans_v4';
CREATE TABLE quotes_v4 (
    scan_sequence INTEGER NOT NULL REFERENCES scans_v4(sequence),
    post_id INTEGER NOT NULL,
    sale_price INTEGER NOT NULL CHECK (sale_price >= 0),
    profit INTEGER,
    PRIMARY KEY (scan_sequence, post_id)
);
INSERT INTO quotes_v4 SELECT * FROM quotes;
CREATE TABLE private_ip_logs_v4 (
    id INTEGER PRIMARY KEY,
    scan_sequence INTEGER UNIQUE REFERENCES scans_v4(sequence),
    installation_id TEXT NOT NULL REFERENCES installations(id),
    received_at INTEGER NOT NULL,
    ip TEXT NOT NULL,
    action TEXT NOT NULL CHECK (action IN ('register', 'scan'))
);
INSERT INTO private_ip_logs_v4 SELECT * FROM private_ip_logs;
DROP TABLE private_ip_logs;
DROP TABLE quotes;
DROP TABLE scans;
ALTER TABLE scans_v4 RENAME TO scans;
ALTER TABLE quotes_v4 RENAME TO quotes;
ALTER TABLE private_ip_logs_v4 RENAME TO private_ip_logs;
CREATE INDEX scans_product_sequence ON scans(mode, product_id, sequence);
CREATE INDEX scans_installation ON scans(installation_id);
CREATE INDEX scans_received ON scans(received_at);
CREATE INDEX scans_association_expiry ON scans(association_expires_at);
CREATE INDEX private_ip_logs_retention ON private_ip_logs(received_at);
CREATE INDEX installations_expiry ON installations(expires_at);

-- Triggers cover old and new writers; only post-migration inserts receive expiry.
CREATE TRIGGER installations_set_expiry AFTER INSERT ON installations
BEGIN
    UPDATE installations SET expires_at = NEW.created_at + 2592000000 WHERE id = NEW.id;
END;
CREATE TRIGGER scans_set_association_expiry AFTER INSERT ON scans
BEGIN
    UPDATE scans SET association_expires_at = NEW.received_at + 2592000000 WHERE sequence = NEW.sequence;
    UPDATE installations SET expires_at = MAX(expires_at, NEW.received_at + 2592000000)
        WHERE id = NEW.installation_id AND expires_at IS NOT NULL;
END;
CREATE TRIGGER installations_hide_revoked_scans AFTER UPDATE OF revoked_at ON installations
WHEN NEW.revoked_at IS NOT NULL
BEGIN
    UPDATE scans SET hidden = 1 WHERE installation_id = NEW.id;
END;
