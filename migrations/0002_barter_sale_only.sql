CREATE TABLE scans_v2 (
    sequence INTEGER PRIMARY KEY AUTOINCREMENT,
    id TEXT NOT NULL UNIQUE,
    installation_id TEXT NOT NULL REFERENCES installations(id),
    received_at INTEGER NOT NULL,
    payload_hash TEXT NOT NULL,
    mode TEXT NOT NULL CHECK (mode IN ('trade', 'group', 'barter')),
    product_id INTEGER NOT NULL,
    source_post_id INTEGER NOT NULL,
    source_price INTEGER,
    stock INTEGER NOT NULL CHECK (stock >= 0),
    CHECK ((mode = 'barter' AND source_price IS NULL) OR
           (mode != 'barter' AND source_price IS NOT NULL AND source_price > 0))
);
INSERT INTO scans_v2 SELECT sequence, id, installation_id, received_at, payload_hash,
    mode, product_id, source_post_id, CASE WHEN mode = 'barter' THEN NULL ELSE source_price END, stock FROM scans;
CREATE TABLE quotes_v2 (
    scan_sequence INTEGER NOT NULL REFERENCES scans_v2(sequence),
    post_id INTEGER NOT NULL,
    sale_price INTEGER NOT NULL CHECK (sale_price >= 0),
    profit INTEGER,
    PRIMARY KEY (scan_sequence, post_id)
);
INSERT INTO quotes_v2 SELECT q.scan_sequence, q.post_id, q.sale_price,
    CASE WHEN s.mode = 'barter' THEN NULL ELSE q.profit END
    FROM quotes q JOIN scans s ON s.sequence = q.scan_sequence;
CREATE TABLE private_ip_logs_v2 (
    id INTEGER PRIMARY KEY,
    scan_sequence INTEGER UNIQUE REFERENCES scans_v2(sequence),
    installation_id TEXT NOT NULL REFERENCES installations(id),
    received_at INTEGER NOT NULL,
    ip TEXT NOT NULL,
    action TEXT NOT NULL CHECK (action IN ('register', 'scan'))
);
INSERT INTO private_ip_logs_v2 SELECT * FROM private_ip_logs;
DROP TABLE private_ip_logs;
DROP TABLE quotes;
DROP TABLE scans;
ALTER TABLE scans_v2 RENAME TO scans;
ALTER TABLE quotes_v2 RENAME TO quotes;
ALTER TABLE private_ip_logs_v2 RENAME TO private_ip_logs;
CREATE INDEX scans_product_sequence ON scans(mode, product_id, sequence);
CREATE INDEX scans_installation ON scans(installation_id);
CREATE INDEX scans_received ON scans(received_at);
CREATE INDEX private_ip_logs_retention ON private_ip_logs(received_at);
