ALTER TABLE scans ADD COLUMN review_json TEXT CHECK (review_json IS NULL OR json_valid(review_json));
