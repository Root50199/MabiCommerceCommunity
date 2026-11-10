ALTER TABLE scans ADD COLUMN price_basis TEXT NOT NULL DEFAULT 'legacy';
ALTER TABLE scans ADD COLUMN observed_source_price INTEGER;
ALTER TABLE scans ADD COLUMN purchase_discount_percent REAL;
